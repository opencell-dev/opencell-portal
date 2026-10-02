import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { E2E_PROTO_DIR, E2E_PROTO_LOG, E2E_PROTO_PORT } from '../../playwright.config';
import { altchaReady, liftLimits, mailedLink, signOut, uniqueEmail } from './helpers';

const BASE = `http://127.0.0.1:${E2E_PROTO_PORT}`;

function serverLog(): string {
  try {
    return readFileSync(E2E_PROTO_LOG, 'utf8');
  } catch {
    return '';
  }
}

// Production bug (2026-10-02): nginx-proxy/Anubis always forward
// X-Forwarded-Proto: https (TLS terminates upstream; this server itself
// only ever speaks plain HTTP -- server.mjs). The 404 rewrite
// (src/proxy.ts, SITE_NOT_FOUND) used to reuse that forwarded https origin
// for a same-process fetch, so Next tried to speak TLS to this http-only
// port and the request failed with a 500 ("wrong version number"),
// reproduced on the live guests for every path a site does not serve
// (NOC: /numbers, /sign-up, /coverage; portal: /noc, /noc/cells, /NOC).
// This server (playwright.config.ts) has OC_TRUSTED_PROXY=127.0.0.1, the
// test runner's own loopback address, so the header below is honored
// exactly as nginx-proxy's would be in production.
test('a path this site does not serve still answers 404, not 500, when forwarded as https', async ({ request }) => {
  const res = await request.get(`${BASE}/noc`, { headers: { 'x-forwarded-proto': 'https' } });
  expect(res.status()).toBe(404);
});

test('…and for a path with no route at all', async ({ request }) => {
  const res = await request.get(`${BASE}/this-path-does-not-exist`, { headers: { 'x-forwarded-proto': 'https' } });
  expect(res.status()).toBe(404);
});

test('the same path answers 404 without the header too (the baseline, unaffected by the fix)', async ({ request }) => {
  const res = await request.get(`${BASE}/noc`);
  expect(res.status()).toBe(404);
});

test('a path this site does serve is unaffected by the header', async ({ request }) => {
  const res = await request.get(`${BASE}/sign-in`, { headers: { 'x-forwarded-proto': 'https' } });
  expect(res.status()).toBe(200);
});

// The 01:17:07Z log line ("failed to get redirect response … wrong version
// number") during email-link confirmation is the same forwarded-origin
// problem, in a different place: a Server Action's redirect() (here,
// sign-out) makes Next do a same-process self-fetch to stream back the new
// page, using the same wrongly-https origin -- this predates the NOC (every
// sign-out, since P1). Next catches the failure and falls back to a plain
// redirect, so this was never visibly broken for a user, only logged and
// slower. The fix is server.mjs's __NEXT_PRIVATE_ORIGIN.
test('signing out (a Server Action redirect) never logs the same self-fetch failure, forwarded as https', async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { 'x-forwarded-proto': 'https' } });
  const page = await context.newPage();
  try {
    liftLimits(E2E_PROTO_DIR);
    const before = serverLog().length;
    const email = uniqueEmail(info, 'protoaction');
    await page.goto('/sign-up');
    await altchaReady(page);
    await page.getByLabel('Name').fill('Proto');
    await page.getByLabel('Email').fill(email);
    await expect(page.locator('input[name="altcha"]')).toHaveValue(/.{20,}/);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(page.getByRole('status')).toContainText('Check your inbox');
    const link = await mailedLink(email, undefined, E2E_PROTO_DIR);
    await page.goto(link);
    await page.getByRole('button', { name: 'Confirm my email' }).click();
    await expect(page).toHaveURL(/\/welcome$/);
    await signOut(page);
    const added = serverLog().slice(before);
    expect(added).not.toContain('failed to get redirect response');
  } finally {
    await context.close();
  }
});
