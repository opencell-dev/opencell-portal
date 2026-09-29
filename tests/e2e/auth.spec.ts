import { expect, test } from '@playwright/test';
import { addPasskey, addPasskeyDevice, e2eDb, liftLimits, mailedLink, signInWithPasskey, signOut, signUpAndVerify, uniqueEmail } from './helpers';

test.beforeEach(() => liftLimits());

test('sign up, verify, add a passkey, sign out, sign in with the passkey', async ({ page }, info) => {
  await addPasskeyDevice(page);
  const email = uniqueEmail(info, 'ada');
  await signUpAndVerify(page, 'Ada', email);
  await addPasskey(page, 'This phone');
  await expect(page.getByRole('status')).toContainText('Your passkey is ready');
  await page.getByRole('link', { name: 'Continue to my numbers' }).click();
  await expect(page.getByRole('heading', { name: 'My numbers' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'My numbers' }).first()).toBeVisible();
  await signOut(page);
  await page.goto('/numbers');
  await expect(page).toHaveURL(/\/sign-in$/);
  await signInWithPasskey(page);
  await expect(page.getByText('Hello Ada.')).toBeVisible();
});

test('a magic link signs in once, after a click (mail scanners do not use it up)', async ({ page, request }, info) => {
  const email = uniqueEmail(info, 'bob');
  await signUpAndVerify(page, 'Bob', email);
  await signOut(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('sign-in link is on its way');
  const link = await mailedLink(email);
  expect((await request.get(link)).status()).toBe(200); // a scanner's GET
  await page.goto(link);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/numbers$/);
  await signOut(page);
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'This link has already been used.' })).toBeVisible();
});

test('the same answer for an unknown address', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('nobody-at-all@example.org');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('If that address has an account');
});

test('sign-up without the proof of work is refused', async ({ page }, info) => {
  const email = uniqueEmail(info, 'bot');
  await page.goto('/sign-up');
  await page.locator('altcha-widget').evaluate((w) => w.remove());
  await page.getByLabel('Name').fill('Bot');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByText('Please complete the “I’m not a robot” check.')).toBeVisible();
  const db = e2eDb();
  expect(db.prepare('SELECT count(*) AS n FROM users WHERE email = ?').get(email)).toEqual({ n: 0 });
  db.close();
});
