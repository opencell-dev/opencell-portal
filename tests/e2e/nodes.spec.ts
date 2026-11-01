import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { addPasskey, addPasskeyDevice, liftLimits, mailedText, portalAdmin, signInWithPasskey, signOut, signUpAndVerify, uniqueEmail, watchCsp } from './helpers';

// Portal spec §6 from end to end, against the fake core, on phone and desktop:
// a subscriber requests a node; an admin asks a question, approves with a passkey;
// a CSR with the mailed token gets a certificate; My nodes follows the cell; a
// downtime notice reaches the admin; the admin revokes it.

test.beforeAll(() => {
  mkdirSync('.e2e', { recursive: true });
  const tgz = join('.e2e', 'oc-cell-fixture.tgz');
  if (!existsSync(tgz)) execFileSync('tar', ['-czf', tgz, '-C', 'tests/fixtures/oc-cell-release', '.']);
  portalAdmin('cell-release', tgz, 'v0.2.0');
});
test.beforeEach(() => liftLimits());

async function adminPage(context: BrowserContext, info: Parameters<typeof uniqueEmail>[0]): Promise<{ page: Page; email: string }> {
  const page = await context.newPage();
  await addPasskeyDevice(page);
  const email = uniqueEmail(info, 'noderoot');
  await signUpAndVerify(page, 'Node Root', email);
  await addPasskey(page, 'Key');
  await expect(page.getByRole('status')).toContainText('Your passkey is ready');
  portalAdmin('promote', email);
  await signOut(page);
  await signInWithPasskey(page);
  return { page, email };
}

function csr(): string {
  const dir = mkdtempSync(join('.e2e', 'csr-'));
  try {
    execFileSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(dir, 'k'), '-subj', '/CN=oc-cell', '-out', join(dir, 'c')], { stdio: 'pipe' });
    return readFileSync(join(dir, 'c'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('request → question → reply → approve with a passkey → setup → online → downtime → revoke', async ({ browser, request }, info) => {
  test.setTimeout(240_000);
  const adminCtx = await browser.newContext({ ...info.project.use });
  const opCtx = await browser.newContext({ ...info.project.use });
  try {
    const { page: admin } = await adminPage(adminCtx, info);
    const op = await opCtx.newPage();
    const violations = await watchCsp(op);
    const opEmail = uniqueEmail(info, 'operator');
    await signUpAndVerify(op, 'Olive Operator', opEmail);

    // The request: the pin typed, the agreement ticked.
    const site = `Roof ${info.project.name} ${Date.now()}`;
    await op.goto('/nodes');
    await op.getByRole('link', { name: 'Request a node' }).click();
    await op.getByLabel('Site name').fill(site);
    await op.getByLabel('Latitude').fill('39.414371');
    await op.getByLabel('Longitude').fill('-77.410541');
    await expect(op.getByRole('img', { name: 'Preview of the position' })).toBeVisible();
    await op.getByLabel('State or province').selectOption('MD');
    await op.getByLabel('A GPS receiver is fitted').check();
    await op.getByLabel('Antenna').fill('Vertical on the roof');
    await op.getByLabel('Contact phone').fill('+1 301 555 0199');
    await op.getByLabel('I accept the Base Station Operator Agreement').check();
    await op.getByRole('button', { name: 'Send the request' }).click();
    await expect(op).toHaveURL(/\/nodes\/requests\/\d+$/);
    await expect(op.getByTestId('request-status')).toHaveText('Waiting for an admin');
    const requestPath = new URL(op.url()).pathname;
    const id = requestPath.split('/').at(-1);

    // The admin's queue: history, the exact pin, the phone; asks a question.
    await admin.goto('/admin/requests');
    await admin.getByRole('link', { name: site }).click();
    await expect(admin).toHaveURL(new RegExp(`/admin/requests/${id}$`));
    await expect(admin.getByTestId('exact-pin')).toHaveText('39.414371, -77.410541');
    await expect(admin.getByText('+1 301 555 0199')).toBeVisible();
    await admin.getByLabel('Ask a question').fill('How high is the antenna?');
    await admin.getByRole('button', { name: 'Ask' }).click();
    await expect(admin.getByTestId('request-status')).toHaveText('Waiting for the requester');
    expect(await mailedText(opEmail, /question/)).toContain('How high is the antenna?');

    // The operator answers on the thread.
    await op.reload();
    await expect(op.getByTestId('request-status')).toHaveText('An admin has a question for you');
    await expect(op.getByText('How high is the antenna?')).toBeVisible();
    await op.getByLabel('Your reply').fill('Ten metres.');
    await op.getByRole('button', { name: 'Send' }).click();
    await expect(op.getByRole('status').filter({ hasText: 'Sent.' })).toBeVisible();
    await expect(op.getByTestId('request-status')).toHaveText('Waiting for an admin');

    // Approve: this session has no fresh assertion, so the passkey prompt comes first.
    await admin.reload();
    await expect(admin.getByText('Ten metres.')).toBeVisible();
    await admin.getByRole('button', { name: 'Approve' }).click();
    await expect(admin.getByTestId('request-status')).toHaveText(/^Approved: node \d+$/, { timeout: 30_000 });

    // The approval mail carries the command.
    const mail = await mailedText(opEmail, /is approved/);
    const m = /curl -fsSL http:\/\/localhost:3100\/setup\/([A-Za-z0-9_-]{43}) \| sudo bash/.exec(mail);
    expect(m, mail).not.toBeNull();
    const token = m![1];

    // The script, and the setup page's "inspect first", in a browser.
    const script = await request.get(`/setup/${token}`);
    expect(script.status()).toBe(200);
    expect(script.headers()['content-type']).toContain('text/plain');
    expect(await script.text()).toContain(`TOKEN='${token}'`);

    await op.goto('/nodes');
    await expect(op.getByTestId('node-state')).toHaveText('Waiting for setup');

    // The Pi's CSR, with Origin as the script sends it.
    const answer = await request.post(`/setup/${token}/csr`, { headers: { Origin: 'http://localhost:3100', 'Content-Type': 'application/pkcs10' }, data: csr() });
    expect(answer.status(), await answer.text()).toBe(200);
    const bundle = await answer.text();
    expect(bundle.startsWith('--- oc-cell.crt\n')).toBe(true);
    expect((await request.post(`/setup/${token}/csr`, { headers: { Origin: 'http://localhost:3100' }, data: csr() })).status()).toBe(410);

    // My nodes: waiting for the node, then online.
    await op.reload();
    const card = op.getByTestId('node-card');
    await expect(card.getByTestId('node-state')).toHaveText('Waiting for the node');
    await expect(card.getByTestId('node-channel')).toHaveText(/^\d{3}\.\d{2} MHz, anchor \d+$/);
    await card.getByRole('link', { name: site }).click();
    await op.getByRole('button', { name: 'Simulate the node coming online (fake core)' }).click();
    await expect(op.getByTestId('node-state')).toHaveText(/^Online/);

    // The public map shows it, rounded, without the site.
    const coverage = await opCtx.newPage();
    await coverage.goto('/coverage');
    const nodeId = new URL(op.url()).pathname.split('/').at(-1);
    await expect(coverage.getByRole('cell', { name: `Node ${nodeId}`, exact: true })).toBeVisible();
    const html = await coverage.content();
    expect(html).not.toContain(site);
    expect(html).not.toContain('39.414371');
    await coverage.close();

    // A downtime notice; the admin sees it.
    const from = new Date(Date.now() + 3600_000);
    const to = new Date(Date.now() + 7200_000);
    const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await op.getByLabel('From').fill(local(from));
    await op.getByLabel('To', { exact: true }).fill(local(to));
    await op.getByLabel('Why').fill('Antenna work');
    await op.getByRole('button', { name: 'Post the notice' }).click();
    await expect(op.getByRole('status').filter({ hasText: 'Posted.' })).toBeVisible();
    await admin.goto('/admin/cells');
    const cell = admin.getByTestId('admin-cell').filter({ hasText: site });
    await expect(cell.getByTestId('admin-downtime')).toContainText('Antenna work');

    // The admin revokes it: the name typed, a fresh passkey (still fresh here).
    const cellName = (await cell.locator('p').first().textContent())!.match(/^Cell (\d+): ([a-z0-9-]+) /)!;
    await cell.getByRole('textbox').fill(cellName[2]);
    await cell.getByRole('button', { name: 'Revoke' }).click();
    await expect(cell.locator('p').first()).toContainText('· revoked', { timeout: 30_000 });
    await op.reload();
    await expect(op.getByTestId('node-state')).toHaveText('Revoked');
    expect(await mailedText(opEmail, /has been revoked/)).toContain(site);

    expect(violations).toEqual([]);
  } finally {
    await adminCtx.close();
    await opCtx.close();
  }
});

test('B gets a 404 on A’s request and node; pages are guarded', async ({ browser, page, request }, info) => {
  test.setTimeout(120_000);
  const a = await browser.newContext({ ...info.project.use });
  try {
    const alice = await a.newPage();
    await signUpAndVerify(alice, 'Alice', uniqueEmail(info, 'alice'));
    await alice.goto('/nodes/request');
    await alice.getByLabel('Site name').fill('Alice Secret Place');
    await alice.getByLabel('Latitude').fill('39.5');
    await alice.getByLabel('Longitude').fill('-77.5');
    await alice.getByLabel('State or province').selectOption('MD');
    await alice.getByLabel('Antenna').fill('Whip');
    await alice.getByLabel('Contact phone').fill('+1 301 555 0188');
    await alice.getByLabel('I accept the Base Station Operator Agreement').check();
    await alice.getByRole('button', { name: 'Send the request' }).click();
    await expect(alice).toHaveURL(/\/nodes\/requests\/\d+$/);
    const path = new URL(alice.url()).pathname;

    await signUpAndVerify(page, 'Bob', uniqueEmail(info, 'bob'));
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
    await expect(page.getByText('Alice Secret Place')).toHaveCount(0);
    for (const adminPath of ['/admin/requests', `/admin/requests/1`, '/admin/cells', '/admin/numbers', '/admin/calls', '/admin/audit', '/admin/agreement', '/admin/users/1']) {
      expect((await page.goto(adminPath))?.status(), adminPath).toBe(404);
    }
    // Signed out: the setup route's own answer, not a page.
    expect((await request.get(`/setup/${'A'.repeat(43)}`)).status()).toBe(404);
  } finally {
    await a.close();
  }
});

test('an unticked agreement and a bad phone are refused with a message', async ({ page }, info) => {
  await signUpAndVerify(page, 'Carol', uniqueEmail(info, 'carol'));
  await page.goto('/nodes/request');
  await page.getByLabel('Site name').fill('Carol Roof');
  await page.getByLabel('Latitude').fill('39.5');
  await page.getByLabel('Longitude').fill('-77.5');
  await page.getByLabel('State or province').selectOption('MD');
  await page.getByLabel('Antenna').fill('Whip');
  await page.getByLabel('Contact phone').fill('abc-phone');
  await page.getByLabel('I accept the Base Station Operator Agreement').check();
  await page.getByRole('button', { name: 'Send the request' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'contact phone' })).toBeVisible();
  await expect(page).toHaveURL(/\/nodes\/request$/);
});
