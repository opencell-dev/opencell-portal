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

/** The newest link mailed to `to` (the outbox transport writes one JSON file per message). */
export async function mailedLink(to: string): Promise<string> {
  let link = '';
  await expect
    .poll(
      () => {
        const dir = join(DIR, 'outbox');
        if (!existsSync(dir)) return '';
        for (const f of readdirSync(dir).sort().reverse()) {
          const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          if (m.to?.[0]?.address === to) {
            link = String(m.text).match(/https?:\/\/\S+/)?.[0] ?? '';
            return link;
          }
        }
        return '';
      },
      { timeout: 15_000 },
    )
    .not.toBe('');
  return link;
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

/** Sign up through the form (CAPTCHA included) and open the verification link. */
export async function signUpAndVerify(page: Page, name: string, email: string) {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await expect(page.locator('input[name="altcha"]')).toHaveValue(/.{20,}/);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  await page.goto(await mailedLink(email));
  await page.getByRole('button', { name: 'Confirm my email' }).click();
  await expect(page).toHaveURL(/\/welcome$/);
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
