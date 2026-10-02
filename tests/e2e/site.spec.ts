import { expect, test } from '@playwright/test';
import { addPasskey, addPasskeyDevice, liftLimits, portalAdmin, signInWithPasskey, signOut, signUpAndVerify, uniqueEmail } from './helpers';

// NOC design §N1.5: the subscriber portal has no NOC. The NOC is on its own
// site (tests/e2e/noc.spec.ts), with its own accounts.

test.beforeEach(() => liftLimits());

const NOC_PATHS = ['/noc', '/noc/', '/noc/cells', '/noc/topology', '/noc/cores/fake', '/noc/lookup', '/noc/demo', '/NOC', '/%6Eoc/cells'];

test('the portal has no NOC: a 404 for a subscriber', async ({ page }, info) => {
  await signUpAndVerify(page, 'Sub', uniqueEmail(info, 'sub'));
  for (const path of NOC_PATHS) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }
  await expect(page.getByRole('link', { name: 'NOC', exact: true })).toHaveCount(0);
});

test("the portal has no NOC for its admins either: a 404, no tab, no link, no NOC role", async ({ page }, info) => {
  await addPasskeyDevice(page);
  const email = uniqueEmail(info, 'padmin');
  await signUpAndVerify(page, 'Padmin', email);
  await addPasskey(page, 'Key');
  await expect(page.getByRole('status')).toContainText('Your passkey is ready');
  expect(portalAdmin('promote', email).trim()).toBe(`${email} is now an admin`);
  await signOut(page);
  await signInWithPasskey(page);
  for (const path of NOC_PATHS) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  }
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'NOC', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Network operations (NOC)' })).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Make an admin' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'NOC operators' })).toHaveCount(0);
  expect(() => portalAdmin('noc-grant', email)).toThrow(/the NOC role is given on the NOC site/);
});
