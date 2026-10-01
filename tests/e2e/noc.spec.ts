import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { addPasskey, addPasskeyDevice, liftLimits, mailedLink, NOC_DIR, NOC_URL, nocAdmin, signInWithPasskey, uniqueEmail, watchCsp } from './helpers';

/** How many messages are in the NOC server's outbox right now. */
function outboxCount(): number {
  try {
    return readdirSync(join(NOC_DIR, 'outbox')).length;
  } catch {
    return 0;
  }
}

// NOC design §4, §9, §10 (plan N1), on the NOC's own site (§N1.5): who opens
// the NOC, what it shows, and the 3 s "Unreachable" on the fake core's
// simulated outage. Ruling 2026-10-01 #8/#9: NOC operators and admins may
// both look up a number (unmasked); the demo controls stay admin-only.
// tests/e2e/site.spec.ts checks the subscriber portal has no NOC at all.

test.use({ baseURL: NOC_URL });
test.beforeEach(() => liftLimits(NOC_DIR));

const STAFF_ONLY = 'This site is for OpenCell staff only, and this account has no staff role here.';

/** Ask the sign-in page for an email link to `email`; returns the link (newer than `after`). */
async function emailLink(page: Page, email: string, after?: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('If that address has an account');
  return mailedLink(email, after, NOC_DIR);
}

/**
 * The NOC site's bootstrap: the CLI adds the account; its first emailed link
 * verifies it and signs it in on Account, where it adds a passkey; with a
 * passkey and no role yet it is signed out.
 */
async function addedWithPasskey(page: Page, info: Parameters<typeof uniqueEmail>[0], tag: string) {
  await addPasskeyDevice(page);
  const email = uniqueEmail(info, tag);
  expect(nocAdmin('add', email, tag)).toContain(`${email} added.`);
  const link = await emailLink(page, email);
  await page.goto(link);
  await page.getByRole('button', { name: 'Confirm my email' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('note')).toContainText('This account has no staff role yet');
  await addPasskey(page, 'Key');
  await expect(page).toHaveURL(/\/sign-in$/);
  return { email, link };
}

/** An added account with a passkey, given `role` by the bootstrap CLI. */
async function staff(page: Page, info: Parameters<typeof uniqueEmail>[0], tag: string, cmd: 'promote' | 'noc-grant') {
  const r = await addedWithPasskey(page, info, tag);
  nocAdmin(cmd, r.email);
  return r;
}

/** The demo controls page: press a button and wait for its message. */
async function demo(page: Page, button: string, says: string | RegExp) {
  await page.goto('/noc/demo');
  await page.getByRole('button', { name: button }).click();
  await expect(page.getByRole('status')).toContainText(says);
}

test('the NOC site has no sign-up and no subscriber pages; its front page is the NOC', async ({ page }) => {
  for (const path of ['/sign-up', '/welcome', '/numbers', '/calls', '/directory', '/nodes', '/coverage', '/operator-agreement']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Sign in to the OpenCell NOC' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign up' })).toHaveCount(0);
});

test('an account with no staff role is refused at sign-in, and told why; a repeat link request mails nothing', async ({ page }, info) => {
  const { email } = await addedWithPasskey(page, info, 'norole');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  // (Next's route announcer is an alert too: pick ours by its text.)
  await expect(page.getByRole('alert').filter({ hasText: STAFF_ONLY })).toBeVisible();
  // M5 (final review): no mail to an account this site would refuse at
  // sign-in anyway -- confirming it would only spend the token on the same
  // refusal, so the answer here is the same as for an unknown address.
  const before = outboxCount();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('If that address has an account');
  expect(outboxCount()).toBe(before);
  const res = await page.goto('/noc');
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(res?.status()).toBe(200);
});

test('a NOC operator opens the NOC with a passkey, including number lookup, but not the admin pages or the demo', async ({ page }, info) => {
  const { email, link } = await staff(page, info, 'nocop', 'noc-grant');
  // An email-link session does not open the NOC.
  await page.goto(await emailLink(page, email, link));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('note')).toContainText('The NOC needs a sign-in with a passkey');
  await page.goto('/noc');
  await expect(page).toHaveURL(/\/sign-in\?noc=1$/);
  await expect(page.getByText('NOC pages need a sign-in with a passkey')).toBeVisible();
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
  await signInWithPasskey(page, /\/noc$/);
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
