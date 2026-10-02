import { execFileSync } from 'node:child_process';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { E2E_NOC_PROTO_DIR, E2E_NOC_PROTO_PORT } from '../../playwright.config';
import { addPasskey, addPasskeyDevice, liftLimits, mailedLink, uniqueEmail } from './helpers';

// The NOC lookup form, forwarded as https (production bug, 2026-10-02):
// this server trusts X-Forwarded-Proto from 127.0.0.1, the test runner's
// own address, as nginx-proxy/Anubis's is trusted in production
// (playwright.config.ts). A systematic check (not shown by this test, which
// passes either way): the server action's argument always arrived as a
// plain string here, with or without src/proxy.ts's and server.mjs's fixes
// for the 404-rewrite and redirect bugs -- that is not the cause of the
// live "That is not a full OpenCell number" refusal for a number typed by
// hand. See also tests/e2e/noc-lookup-anubis.spec.ts (through a real
// Anubis) and tests/unit/noc-lookup.test.ts (normalizeNumber hardening).
const BASE = `http://localhost:${E2E_NOC_PROTO_PORT}`;
test.use({ baseURL: BASE, extraHTTPHeaders: { 'x-forwarded-proto': 'https' } });
test.beforeEach(() => liftLimits(E2E_NOC_PROTO_DIR));

function nocAdminProto(...args: string[]) {
  return execFileSync('npx', ['tsx', 'scripts/oc-portal-admin.ts', ...args], {
    env: {
      ...process.env,
      OC_SITE: 'noc',
      OC_ORIGIN: BASE,
      OC_RP_ID: 'localhost',
      OC_SECRET: 'e2e-noc-proto-secret-e2e-noc-proto-0000',
      OC_DB_PATH: `${E2E_NOC_PROTO_DIR}/portal.db`,
    },
    encoding: 'utf8',
  });
}

/** An admin, signed in with a passkey, on /noc. */
async function signedInAdmin(page: Page, info: TestInfo, tag: string): Promise<void> {
  await addPasskeyDevice(page);
  const email = uniqueEmail(info, tag);
  expect(nocAdminProto('add', email, 'Lookup')).toContain(`${email} added.`);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('If that address has an account');
  const link = await mailedLink(email, undefined, E2E_NOC_PROTO_DIR);
  await page.goto(link);
  await page.getByRole('button', { name: 'Confirm my email' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await addPasskey(page, 'Key');
  await expect(page).toHaveURL(/\/sign-in$/);
  nocAdminProto('promote', email);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/noc$/);
}

test('a staff member looks up a number on the NOC site, forwarded as https', async ({ page }, info) => {
  await signedInAdmin(page, info, 'lookup');
  await page.goto('/noc/lookup');
  await page.getByLabel('Number').fill('+883160655501234');
  await page.getByRole('button', { name: 'Look up' }).click();
  // A real refusal (unknown to the fake core), never the validation message:
  // this is a complete, valid number, typed exactly as the field shows it.
  await expect(page.getByRole('alert').filter({ hasText: 'No subscriber has' })).toHaveText('No subscriber has +883160655501234 on fake.');
});

// Message 1 (2026-10-02): the Number field is a plain controlled input
// (useState, onChange) -- nothing in it could send a stale or empty value.
// Typed with spaces, as the field's own placeholder groups it, it must
// reach the fake core exactly as normalizeNumber() groups it back together.
test('typed with spaces, the number still reaches the fake core (the field is not stale)', async ({ page }, info) => {
  await signedInAdmin(page, info, 'lookupspaces');
  await page.goto('/noc/lookup');
  await page.getByLabel('Number').pressSequentially('+883 1 606 555 01234', { delay: 10 });
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No subscriber has' })).toHaveText('No subscriber has +883160655501234 on fake.');
});
