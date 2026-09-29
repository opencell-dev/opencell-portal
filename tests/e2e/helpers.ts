import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CDPSession, expect, type Page, type TestInfo } from '@playwright/test';
import Database from 'better-sqlite3';

const DIR = '.e2e';

/** The e2e server's database, opened directly (setup and checks only). */
export function e2eDb() {
  return new Database(join(DIR, 'portal.db'));
}

/** Lift the sign-up, link and passkey sign-in limits: every e2e test comes from 127.0.0.1. */
export function liftLimits() {
  const db = e2eDb();
  for (const name of ['signup_ip', 'signup_email', 'magic_email', 'magic_ip', 'signin_ip']) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      `limit.${name}`,
      JSON.stringify({ max: 10_000, windowS: 3600 }),
    );
  }
  db.close();
}

export function uniqueEmail(info: TestInfo, tag: string) {
  return `${tag}-${info.project.name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.org`;
}

/** The links mailed to `to`, oldest first (the outbox transport writes one `<ms>-<rand>.json` file per message). */
function linksTo(to: string): string[] {
  const dir = join(DIR, 'outbox');
  if (!existsSync(dir)) return [];
  const links: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (m.to?.[0]?.address === to) links.push(String(m.text).match(/https?:\/\/\S+/)?.[0] ?? '');
  }
  return links;
}

/**
 * The newest link mailed to `to`. With `after` (a link already read), wait
 * for a message that arrived after that one, so a slow mail queue can't hand
 * back the previous link.
 */
export async function mailedLink(to: string, after?: string): Promise<string> {
  let link = '';
  await expect
    .poll(
      () => {
        const links = linksTo(to);
        const fresh = after === undefined ? links : links.slice(links.lastIndexOf(after) + 1);
        link = fresh.at(-1) ?? '';
        return link;
      },
      { timeout: 15_000 },
    )
    .not.toBe('');
  return link;
}

/** Wait until the ALTCHA widget is defined and rendered, so focusing the form starts its proof of work. */
export async function altchaReady(page: Page) {
  await page.waitForFunction(() => Boolean(customElements.get('altcha-widget')));
  await expect(page.locator('input[name="altcha"]')).toBeAttached();
}

/** A Chromium virtual authenticator: a platform passkey with user verification. */
export async function addPasskeyDevice(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/** Sign up through the form (CAPTCHA included) and open the verification link; returns that link. */
export async function signUpAndVerify(page: Page, name: string, email: string): Promise<string> {
  await page.goto('/sign-up');
  await altchaReady(page);
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await expect(page.locator('input[name="altcha"]')).toHaveValue(/.{20,}/);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  const link = await mailedLink(email);
  await page.goto(link);
  await page.getByRole('button', { name: 'Confirm my email' }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  return link;
}

/** Add a passkey on /welcome or /account with the page's virtual authenticator. */
export async function addPasskey(page: Page, name: string) {
  await page.getByLabel('Name for this passkey').fill(name);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
}

export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
}

export async function signInWithPasskey(page: Page) {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/numbers$/);
}

/** Collect CSP violations the page reports (securitypolicyviolation events), across navigations. */
export async function watchCsp(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.exposeFunction('__ocCspViolation', (s: string) => seen.push(s));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __ocCspViolation: (s: string) => void }).__ocCspViolation(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return seen;
}
