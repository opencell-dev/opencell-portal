import { expect, type Page, test } from '@playwright/test';
import { addPasskey, addPasskeyDevice, liftLimits, portalAdmin, signInWithPasskey, signOut, signUpAndVerify, uniqueEmail, watchCsp } from './helpers';

// NOC design §4, §9, §10 (plan N1): who opens the NOC, what it shows, and the
// 3 s "Unreachable" on the fake core's simulated outage. Ruling 2026-10-01
// #8/#9: NOC operators and admins may both look up a number (unmasked); the
// demo controls stay admin-only.

test.beforeEach(() => liftLimits());

const NOC_PAGES = ['/noc', '/noc/cells', '/noc/topology', '/noc/cores/fake', '/noc/lookup', '/noc/demo'];

/** A verified account with a passkey, given `role` by the bootstrap CLI, then signed in with the passkey. */
async function staff(page: Page, info: Parameters<typeof uniqueEmail>[0], tag: string, cmd: 'promote' | 'noc-grant') {
  await addPasskeyDevice(page);
  const email = uniqueEmail(info, tag);
  await signUpAndVerify(page, tag, email);
  await addPasskey(page, 'Key');
  await expect(page.getByRole('status')).toContainText('Your passkey is ready');
  portalAdmin(cmd, email);
  return email;
}

/** The demo controls page: press a button and wait for its message. */
async function demo(page: Page, button: string, says: string | RegExp) {
  await page.goto('/noc/demo');
  await page.getByRole('button', { name: button }).click();
  await expect(page.getByRole('status')).toContainText(says);
}

test('the NOC is a 404 for a subscriber, with no NOC tab', async ({ page }, info) => {
  await signUpAndVerify(page, 'Sub', uniqueEmail(info, 'sub'));
  for (const path of NOC_PAGES) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }
  await expect(page.getByRole('link', { name: 'NOC', exact: true })).toHaveCount(0);
});

test('a NOC operator opens the NOC with a passkey, including number lookup, but not the admin pages or the demo', async ({ page }, info) => {
  await staff(page, info, 'nocop', 'noc-grant');
  // The email-link session does not open the NOC.
  await page.goto('/noc');
  await expect(page).toHaveURL(/\/sign-in\?noc=1$/);
  await expect(page.getByText('NOC pages need a sign-in with a passkey')).toBeVisible();
  await signOut(page);
  await page.goto('/sign-in?noc=1');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/noc$/);
  await expect(page.getByRole('heading', { name: 'Network overview' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'NOC', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
  // Ruling 2026-10-01 #8/#9: a NOC operator sees and can use the number lookup.
  await expect(page.getByRole('link', { name: 'Number lookup' })).toBeVisible();
  for (const path of ['/admin', '/admin/users', '/noc/demo']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }
  for (const path of ['/noc/cells', '/noc/topology', '/noc/cores/fake', '/noc/lookup']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
  }
  await page.goto('/noc/lookup');
  await expect(page.getByRole('heading', { name: 'Number lookup' })).toBeVisible();
});

test('an admin sees the demo network, a core that stops answering as Unreachable within the deadline, and a number', async ({ page }, info) => {
  const violations = await watchCsp(page);
  await staff(page, info, 'nocadmin', 'promote');
  await signOut(page);
  await signInWithPasskey(page);
  try {
    await demo(page, 'Load the demo network', 'The demo network is loaded on fake.');
    await page.getByRole('link', { name: 'NOC', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Network overview' })).toBeVisible();
    await expect(page.getByRole('note')).toContainText('Fake core: demo data');
    await expect(page.getByText('Cell 4 "Harrisburg 1" on fake offline (last HELLO 4 min ago)')).toBeVisible();
    await expect(page.getByText('Cell 5 "Reading 1" on fake has never connected')).toBeVisible();

    await page.goto('/noc/cells?state=online');
    await expect(page.getByRole('link', { name: 'Lancaster 1' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Harrisburg 1' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Lancaster 2' }).click();
    await expect(page.getByRole('heading', { name: 'Lancaster 2' })).toBeVisible();
    await expect(page.getByText('Part 97')).toBeVisible();

    await page.goto('/noc/topology');
    await expect(page.getByRole('img', { name: /OpenCell topology: 1 cores, 5 cells/ })).toBeVisible();

    await page.goto('/noc/lookup');
    const hint = (await page.getByText('Demo numbers to try:').textContent()) ?? '';
    const number = hint.match(/\+883-1-717-464-\d{5}/)?.[0];
    expect(number).toBeTruthy();
    await page.getByLabel('Number').fill(number!);
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByRole('status')).toContainText('activated');
    await expect(page.getByRole('heading', { name: 'Calls, last 30 days' })).toBeVisible();

    // Review I1: a not-found lookup must say so, not "did not answer" — a
    // number whose exchange (Boise's, site index 2) is never seeded on this
    // single-core demo, so it is always unassigned here, not a core outage.
    await page.getByLabel('Number').fill('+883-1-208-345-12345');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByText('No subscriber has +883120834512345 on fake.')).toBeVisible();

    // A core that never answers: the overview gives up on it at the 3 s deadline.
    await demo(page, 'Stop answering (fake)', 'fake now hangs every call.');
    const t0 = Date.now();
    await page.goto('/noc');
    await expect(page.getByText('Unreachable').first()).toBeVisible();
    expect(Date.now() - t0).toBeLessThan(10_000);
    await expect(page.getByText('fake did not answer within 3 s')).toBeVisible();

    await demo(page, 'Answer normally', 'fake answers again.');
    await page.goto('/noc');
    await expect(page.getByText('Answering', { exact: true })).toBeVisible();
    expect(violations).toEqual([]);
  } finally {
    // Best effort, so a failure above is the one reported: the next tests share this server's fake core.
    await demo(page, 'Answer normally', 'fake answers again.').catch(() => {});
  }
});
