import { expect, test } from '@playwright/test';
import { addPasskey, addPasskeyDevice, e2eDb, liftLimits, portalAdmin, signInWithPasskey, signOut, signUpAndVerify, uniqueEmail } from './helpers';

test.beforeEach(() => liftLimits());

test('admin pages are a 404 for a subscriber', async ({ page }, info) => {
  await signUpAndVerify(page, 'Gus', uniqueEmail(info, 'gus'));
  for (const path of ['/admin', '/admin/users']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  }
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
});

test('an admin needs a passkey sign-in, and a fresh passkey to promote', async ({ page }, info) => {
  await addPasskeyDevice(page);
  const email = uniqueEmail(info, 'root');
  await signUpAndVerify(page, 'Root', email);
  await addPasskey(page, 'Key');
  await expect(page.getByRole('status')).toContainText('Your passkey is ready');
  expect(portalAdmin('promote', email).trim()).toBe(`${email} is now an admin`);

  // The session from the email link does not open admin pages.
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/sign-in\?admin=1$/);
  await expect(page.getByText('Admin pages need a sign-in with a passkey')).toBeVisible();
  await signOut(page);
  await signInWithPasskey(page);
  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: 'Core' })).toBeVisible();
  await expect(page.getByText('fake-core')).toBeVisible();

  const other = uniqueEmail(info, 'deputy');
  const db = e2eDb();
  db.prepare('INSERT INTO users (name, email, email_verified_at, created_at) VALUES (?, ?, ?, ?)').run('Deputy', other, Date.now(), Date.now());
  db.close();
  await page.goto('/admin/users');
  await page.getByLabel('Email of the account to make an admin').fill(other);
  await page.getByRole('button', { name: 'Make admin' }).click();
  await expect(page.getByRole('status')).toHaveText(`${other} is now an admin.`);
  const check = e2eDb();
  const row = check
    .prepare("SELECT r.granted_by AS by FROM user_roles r JOIN users u ON u.id = r.user_id WHERE u.email = ? AND r.role = 'admin'")
    .get(other) as { by: number };
  const reauth = check.prepare("SELECT count(*) AS n FROM audit WHERE action = 'session.reauth' AND actor_id = ?").get(row.by) as { n: number };
  check.close();
  expect(row.by).toBeGreaterThan(0);
  expect(reauth.n).toBe(1);
});
