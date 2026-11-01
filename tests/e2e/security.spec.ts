import { expect, test } from '@playwright/test';
import { addPasskey, addPasskeyDevice, altchaReady, e2eDb, liftLimits, mailedLink, portalAdmin, signUpAndVerify, uniqueEmail, watchCsp } from './helpers';

test.beforeEach(() => liftLimits());

// Every CSP violation fails these tests, including any from Next's own
// code: watchCsp reports the directive, source and sample so one is easy to trace.

test('pages carry a nonce CSP and the hardening headers', async ({ request }) => {
  for (const path of ['/', '/sign-up', '/sign-in', '/coverage', '/operator-agreement']) {
    const res = await request.get(path);
    const h = res.headers();
    expect(h['content-security-policy'], path).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(h['content-security-policy'], path).not.toContain('unsafe-inline');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    // 'same-origin', not 'no-referrer': src/lib/web-security.ts deliberately
    // keeps the referrer on same-origin navigations so a same-origin HTML
    // form POST still carries an Origin header for our own origin check.
    expect(h['referrer-policy']).toBe('same-origin');
    expect(h['x-powered-by']).toBeUndefined();
  }
});

test('no CSP violation and no third-party request through sign-up, passkey and account', async ({ page }, info) => {
  const violations = await watchCsp(page);
  const foreign: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost:3100/') && !r.url().startsWith('data:')) foreign.push(r.url());
  });
  await addPasskeyDevice(page);
  await signUpAndVerify(page, 'Csp', uniqueEmail(info, 'csp'));
  await addPasskey(page, 'Key');
  await expect(page.getByRole('status')).toContainText('Your passkey is ready');
  await page.goto('/account');
  await page.goto('/operator-agreement');
  expect(violations).toEqual([]);
  expect(foreign).toEqual([]);
});

test('the ALTCHA widget on /sign-up raises no CSP violation while it mounts and solves', async ({ page }, info) => {
  const violations = await watchCsp(page);
  await page.goto('/sign-up');
  await altchaReady(page);
  await page.getByLabel('Name').fill('Altcha');
  await page.getByLabel('Email').fill(uniqueEmail(info, 'altcha'));
  // auto="onfocus": focusing the form starts the self-hosted proof-of-work;
  // once it solves, the widget fills its own hidden input.
  await expect(page.locator('input[name="altcha"]')).toHaveValue(/.{20,}/);
  expect(violations).toEqual([]);
});

test('state-changing requests from another origin, or with none, are refused', async ({ request }) => {
  const evil = await request.post('/sign-up', { headers: { Origin: 'https://evil.example' }, form: { name: 'x' } });
  expect(evil.status()).toBe(403);
  const none = await request.post('/account', { form: { listed: '0' } });
  expect(none.status()).toBe(403);
});

test('every P3 page and the CSR route refuse a foreign Origin, and a CSR post with none (a server action posted anywhere)', async ({ request }) => {
  const token = 'A'.repeat(43);
  for (const path of ['/nodes', '/nodes/request', '/nodes/agreement', '/nodes/1', '/nodes/requests/1', '/admin/requests', '/admin/requests/1', '/admin/cells', '/admin/numbers', '/admin/calls', '/admin/audit', '/admin/agreement', '/admin/users/1', `/setup/${token}/csr`]) {
    const evil = await request.post(path, { headers: { Origin: 'https://evil.example', 'Next-Action': 'abc' }, data: 'x' });
    expect(evil.status(), path).toBe(403);
  }
  const none = await request.post(`/setup/${token}/csr`, { data: 'x' });
  expect(none.status()).toBe(403);
});

test('a real same-origin form POST is accepted with no client JavaScript at all (the origin check does not block real browsers)', async ({
  page,
  browser,
}, info) => {
  // Sign up normally (ALTCHA needs JS to solve its proof-of-work) just to get
  // a verification link mailed; the no-JS part under test is submitting the
  // email-link confirm form itself, which is a plain server-action <form> and
  // should progressively enhance down to a native HTML POST.
  await page.goto('/sign-up');
  await altchaReady(page);
  const email = uniqueEmail(info, 'nojs');
  await page.getByLabel('Name').fill('NoJs');
  await page.getByLabel('Email').fill(email);
  await expect(page.locator('input[name="altcha"]')).toHaveValue(/.{20,}/);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  const link = await mailedLink(email);

  const context = await browser.newContext({ ...info.project.use, javaScriptEnabled: false });
  const noJsPage = await context.newPage();
  const res = await noJsPage.goto(link);
  expect(res?.status()).toBe(200);
  await noJsPage.getByRole('button', { name: 'Confirm my email' }).click();
  // A rejected Origin would leave the browser on the link's own URL showing
  // the 403 body; a real accept redirects on to /welcome (spec §3).
  await expect(noJsPage).toHaveURL(/\/welcome$/, { timeout: 15_000 });
  await context.close();
});

test('the session cookie is HttpOnly and SameSite=Lax; forged client-IP headers are ignored', async ({ browser }, info) => {
  const context = await browser.newContext({
    ...info.project.use,
    extraHTTPHeaders: { 'x-oc-client-ip': '203.0.113.99', 'x-forwarded-for': '203.0.113.98' },
  });
  const page = await context.newPage();
  const email = uniqueEmail(info, 'ip');
  await signUpAndVerify(page, 'Ip', email);
  const cookie = (await context.cookies()).find((c) => c.name === 'oc_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  const db = e2eDb();
  const rows = db
    .prepare("SELECT a.ip FROM audit a JOIN users u ON a.target = 'user:' || u.id WHERE u.email = ? AND a.action = 'account.signup'")
    .all(email);
  db.close();
  expect(rows).toEqual([{ ip: '127.0.0.1' }]);
  await context.close();
});

test('the directory and every signed-in page need a session', async ({ page }) => {
  for (const path of ['/numbers', '/calls', '/directory', '/nodes', '/account', '/welcome']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/sign-in$/);
  }
});

// ---- Portal P2: numbers (spec §10, §13) ----

test('the number pages need a session; their JSON answers 401 signed out', async ({ page, request }) => {
  for (const path of ['/numbers/new', '/numbers/new/%2B8831717464', '/numbers/new/confirm?number=%2B883171746412345', '/numbers/%2B883171746412345/activate', '/admin/limits']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/sign-in$/);
  }
  for (const path of ['/api/places?q=lancaster', '/api/numbers/status']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(401);
    expect(res.headers()['cache-control'], path).toBe('no-store');
  }
});

test('number actions posted from another origin are refused', async ({ request }) => {
  for (const path of ['/numbers/new/confirm?number=%2B883171746412345', '/numbers/%2B883171746412345/activate', '/numbers', '/admin/limits']) {
    const res = await request.post(path, { headers: { Origin: 'https://evil.example', 'Next-Action': '00' }, form: { number: '+883171746412345' } });
    expect(res.status(), path).toBe(403);
  }
});

test('the real get-a-number action, posted from another origin with the real session, is refused; from its own, it runs', async ({ page, baseURL }, info) => {
  portalAdmin('nanpa-refresh', '--dir', 'tests/fixtures/nanpa');
  await signUpAndVerify(page, 'Origin', uniqueEmail(info, 'origin'));
  const station = String((info.project.name === 'phone' ? 60000 : 20000) + Math.floor(Math.random() * 30000));
  const number = `+8831717843${station}`;
  const url = `/numbers/new/confirm?number=${encodeURIComponent(number)}`;
  await page.goto(url);
  // The form's real fields, action id included: the no-JavaScript POST the page itself would send.
  const fields = await page
    .locator('form', { has: page.getByRole('button', { name: 'Get this number' }) })
    .evaluate((f) => [...new FormData(f as HTMLFormElement).entries()].map(([k, v]) => [k, String(v)]));
  expect(fields.map(([k]) => k).some((k) => k.startsWith('$ACTION'))).toBe(true);
  const multipart = Object.fromEntries(fields);
  const held = () => {
    const db = e2eDb();
    const row = db.prepare('SELECT number FROM numbers WHERE number = ?').get(number);
    db.close();
    return row;
  };
  const evil = await page.request.post(url, { headers: { Origin: 'https://evil.example' }, multipart });
  expect(evil.status()).toBe(403);
  expect(held()).toBeUndefined();
  const none = await page.request.post(url, { multipart });
  expect(none.status()).toBe(403);
  expect(held()).toBeUndefined();
  // The same fields from the portal's own origin do run it, so the refusals above were about the origin.
  await page.request.post(url, { headers: { Origin: new URL(baseURL!).origin }, multipart });
  expect(held()).toEqual({ number });
});

test('no CSP violation and no third-party request through get-a-number, the QR and My numbers; the directory is noindex', async ({ page }, info) => {
  portalAdmin('nanpa-refresh', '--dir', 'tests/fixtures/nanpa');
  const violations = await watchCsp(page);
  const foreign: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost:3100/') && !r.url().startsWith('data:')) foreign.push(r.url());
  });
  await signUpAndVerify(page, 'CspNum', uniqueEmail(info, 'cspnum'));
  await page.goto('/numbers/new');
  await page.getByLabel(/A city, a state/).fill('york');
  await page.getByRole('link', { name: /^York, PA/ }).click();
  await page.getByRole('list', { name: 'Free numbers' }).getByRole('link').first().click();
  await page.getByRole('button', { name: 'Get this number' }).click();
  await expect(page.getByTestId('qr').locator('svg')).toBeVisible();
  await page.goto('/numbers');
  await expect(page.getByTestId('number-card')).toHaveCount(1);
  await page.goto('/calls');
  await page.goto('/directory');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  expect(violations).toEqual([]);
  expect(foreign).toEqual([]);
});
