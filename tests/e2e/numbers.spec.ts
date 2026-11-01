import { type Browser, expect, type Page, test } from '@playwright/test';
import { liftLimits, portalAdmin, signUpAndVerify, uniqueEmail } from './helpers';

// Portal spec §4.1 and §5 against the fake core, on phone and desktop: find
// a place, pick one of 8, confirm, see the QR; the card on My numbers goes
// waiting → activated → registered. The exchanges come from the trimmed
// NANPA fixtures, imported the way the weekly timer does it.

test.beforeAll(() => {
  portalAdmin('nanpa-refresh', '--dir', 'tests/fixtures/nanpa');
});
test.beforeEach(() => liftLimits());

/** A station no other test (or project) picks: the vanity numbers must not collide. */
function station(info: { project: { name: string } }): string {
  const base = info.project.name === 'phone' ? 50000 : 10000;
  return String(base + Math.floor(Math.random() * 39000)).padStart(5, '0');
}

async function freshUser(page: Page, info: Parameters<typeof uniqueEmail>[0], name: string) {
  await signUpAndVerify(page, name, uniqueEmail(info, name.toLowerCase()));
}

/** Search → Lancaster, PA → the shortlist → the first number → confirm → get; the activation page's URL. */
async function getLancasterNumber(page: Page): Promise<string> {
  await page.goto('/numbers/new');
  await page.getByLabel(/A city, a state/).fill('lancaster');
  await page.getByRole('link', { name: /^Lancaster, PA \(717-291/ }).click();
  await expect(page).toHaveURL(/\/numbers\/new\/(%2B|\+)8831717291$/);
  const free = page.getByRole('list', { name: 'Free numbers' }).getByRole('link');
  await expect(free).toHaveCount(8);
  await expect(page.getByText('Served by East (core 1)')).toBeVisible();
  await free.first().click();
  await expect(page).toHaveURL(/\/numbers\/new\/confirm\?number=/);
  await expect(page.getByTestId('rule')).toHaveText(
    "This number is yours only once a terminal activates it. If it isn't activated within 3 days, it goes back to the pool.",
  );
  await expect(page.getByRole('checkbox', { name: /List this number in the directory/ })).toBeChecked();
  await expect(page.getByText('East (core 1)')).toBeVisible();
  await page.getByRole('button', { name: 'Get this number' }).click();
  await expect(page).toHaveURL(/\/numbers\/(%2B|\+)8831717\d{8}\/activate$/);
  return page.url();
}

test('get a number from a place: 8 to choose from, the rule, the QR and its countdown', async ({ page }, info) => {
  await freshUser(page, info, 'Ada');
  await getLancasterNumber(page);
  await expect(page.getByTestId('qr').locator('svg')).toBeVisible();
  await expect(page.getByTestId('countdown')).toHaveText(/^2 d 23 h 5\d m$/);
  await page.getByText('Show as text').click();
  await expect(page.getByTestId('qr-text')).toHaveText(/^opencell:2:[A-Za-z0-9_-]{100}$/);
  // A reload within 15 minutes still shows it.
  await page.reload();
  await expect(page.getByTestId('qr').locator('svg')).toBeVisible();
});

test('a vanity number, typed the way people write it', async ({ page }, info) => {
  await freshUser(page, info, 'Vic');
  const s = station(info);
  await page.goto('/numbers/new');
  await page.getByLabel(/A city, a state/).fill(`(717) 464-${s}`);
  await page.getByRole('link', { name: `Check +8831717464${s} →` }).click();
  await expect(page.getByTestId('confirm-number')).toHaveText(`+883 1 717 464 ${s}`);
  await expect(page.getByText('Lancaster, PA')).toBeVisible();
  await page.getByRole('button', { name: 'Get this number' }).click();
  await expect(page).toHaveURL(new RegExp(`/numbers/(%2B|\\+)8831717464${s}/activate$`));
  // A 10-digit phone number gets a plain explanation.
  await page.goto('/numbers/new');
  await page.getByLabel(/A city, a state/).fill('(717) 464-1234');
  await expect(page.getByText(/type the 11 digits after \+883 1/)).toBeVisible();
  // A non-geographic area code is never offered.
  await page.goto(`/numbers/new/confirm?number=${encodeURIComponent('+883150020012345')}`);
  await expect(page.getByText(/Area code 500 is not tied to a place/)).toBeVisible();
});

async function otherUser(browser: Browser, info: Parameters<typeof uniqueEmail>[0]) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await freshUser(page, info, 'Bob');
  return { ctx, page };
}

test("another account's number is a 404", async ({ page, browser }, info) => {
  await freshUser(page, info, 'Ann');
  const url = await getLancasterNumber(page);
  const bob = await otherUser(browser, info);
  const res = await bob.page.goto(url);
  expect(res?.status()).toBe(404);
  await expect(bob.page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await bob.ctx.close();
});
