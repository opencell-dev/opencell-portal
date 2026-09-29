import { expect, test } from '@playwright/test';
import { addPasskey, addPasskeyDevice, e2eDb, liftLimits, mailedLink, signUpAndVerify, uniqueEmail } from './helpers';

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
