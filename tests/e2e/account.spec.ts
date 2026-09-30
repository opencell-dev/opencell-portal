import { expect, test } from '@playwright/test';
import {
  addPasskey,
  addPasskeyDevice,
  e2eDb,
  liftLimits,
  mailedLink,
  portalAdmin,
  signInWithPasskey,
  signOut,
  signUpAndVerify,
  uniqueEmail,
} from './helpers';

test.beforeEach(() => liftLimits());

test('directory listing is on by default and can be switched off', async ({ page }, info) => {
  await signUpAndVerify(page, 'Dee', uniqueEmail(info, 'dee'));
  await page.goto('/account');
  await expect(page.getByText('You are listed')).toBeVisible();
  await page.getByRole('button', { name: 'Stop listing me' }).click();
  await expect(page.getByText('You are not listed in the directory.')).toBeVisible();
  await page.getByRole('button', { name: 'List me in the directory' }).click();
  await expect(page.getByText('You are listed')).toBeVisible();
});

test('changing the email takes effect only from the new address’s link', async ({ page }, info) => {
  const old = uniqueEmail(info, 'eve');
  const next = uniqueEmail(info, 'eve-new');
  await signUpAndVerify(page, 'Eve', old);
  await page.goto('/account');
  await page.getByLabel('New email').fill(next);
  await page.getByRole('button', { name: 'Change email' }).click();
  await expect(page.getByText('We sent a link to the new address')).toBeVisible();
  await expect(page.getByTestId('account-email')).toHaveText(old);
  await page.goto(await mailedLink(next));
  await page.getByRole('button', { name: 'Use this address' }).click();
  await expect(page).toHaveURL(/\/account\?email=changed$/);
  await expect(page.getByTestId('account-email')).toHaveText(next);
});

test('passkeys are listed and removed; a deleted account is gone', async ({ page }, info) => {
  await addPasskeyDevice(page);
  const email = uniqueEmail(info, 'fay');
  await signUpAndVerify(page, 'Fay', email);
  await page.goto('/account');
  await expect(page.getByText('You have no passkey yet')).toBeVisible();
  await addPasskey(page, 'Laptop');
  await expect(page.getByText('Laptop')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Laptop' }).click();
  await expect(page.getByText('You have no passkey yet')).toBeVisible();

  await page.getByLabel('Type your email address to confirm').fill('wrong@example.org');
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await expect(page.getByText('Type your email address exactly to confirm.')).toBeVisible();
  await page.getByLabel('Type your email address to confirm').fill(email);
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await expect(page).toHaveURL(/\/\?deleted=1$/);
  await page.goto('/numbers');
  await expect(page).toHaveURL(/\/sign-in$/);
  const db = e2eDb();
  expect(db.prepare('SELECT count(*) AS n FROM users WHERE email = ?').get(email)).toEqual({ n: 0 });
  const del = db.prepare("SELECT actor_id, detail FROM audit WHERE action = 'account.delete' ORDER BY id DESC LIMIT 1").get() as { actor_id: number; detail: string };
  expect(del.actor_id).toBeGreaterThan(0);
  expect(del.detail).not.toContain(email);
  db.close();
});

test('an admin confirms with a passkey on the account page to add a second passkey and remove one', async ({ page }, info) => {
  const { cdp, authenticatorId: phone } = await addPasskeyDevice(page);
  const email = uniqueEmail(info, 'ivy');
  await signUpAndVerify(page, 'Ivy', email);
  await addPasskey(page, 'Phone');
  await expect(page.getByRole('status')).toContainText('Your passkey is ready');
  expect(portalAdmin('promote', email).trim()).toBe(`${email} is now an admin`);
  await signOut(page);
  await signInWithPasskey(page); // a passkey session, but not freshly confirmed

  const db = e2eDb();
  const { id: userId } = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number };
  db.close();
  const count = (sql: string) => {
    const d = e2eDb();
    const n = (d.prepare(sql).get(userId) as { n: number }).n;
    d.close();
    return n;
  };
  const reauths = () => count("SELECT count(*) AS n FROM audit WHERE action = 'session.reauth' AND actor_id = ?");
  const keys = () => count('SELECT count(*) AS n FROM passkeys WHERE user_id = ?');

  // One virtual authenticator can't both confirm with its passkey and create
  // a second one (the server excludes the credential it already holds). So
  // once the phone has answered the confirmation, before the page goes on to
  // create the new passkey, swap the phone for a security key, as a person
  // would pick up their backup key.
  let swapped = false;
  await page.exposeFunction('__ocAfterPasskeyCheck', async () => {
    if (swapped) return;
    swapped = true;
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: phone });
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'usb',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
  });
  await page.addInitScript(() => {
    const creds = navigator.credentials;
    const get = creds.get.bind(creds);
    creds.get = async (options?: CredentialRequestOptions) => {
      const c = await get(options);
      await (window as unknown as { __ocAfterPasskeyCheck: () => Promise<void> }).__ocAfterPasskeyCheck();
      return c;
    };
  });

  await page.goto('/account');
  expect(reauths()).toBe(0);
  await addPasskey(page, 'Backup key');
  await expect(page.getByRole('button', { name: 'Remove Backup key' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Phone' })).toBeVisible();
  expect(swapped).toBe(true);
  expect(reauths()).toBe(1);
  expect(keys()).toBe(2);

  // The confirmation lasts five minutes; end it, so removing asks again
  // (the security key, now the only authenticator, answers).
  const d = e2eDb();
  d.prepare('UPDATE sessions SET reauth_at = NULL WHERE user_id = ?').run(userId);
  d.close();
  await page.getByRole('button', { name: 'Remove Backup key' }).click();
  await expect(page.getByRole('button', { name: 'Remove Backup key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove Phone' })).toBeVisible();
  expect(reauths()).toBe(2);
  expect(keys()).toBe(1);
});
