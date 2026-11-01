import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, issuedCerts, nodes, nodeState, setupTokens, userRoles, users } from '@/db/schema';
import { runAdmin } from '@/lib/admin-cli';
import { submitRequest } from '@/lib/nodes/requests';
import { currentRelease, publishRelease } from '@/lib/nodes/release';
import { approveRequest } from '@/lib/nodes/review';
import { handleCsr, handleScript, handleTarball } from '@/lib/nodes/setup';
import { makeSetupToken, SETUP_TOKEN_MS } from '@/lib/nodes/setup-tokens';
import { setLimit } from '@/lib/ratelimit';
import { hashToken } from '@/lib/tokens';
import { type CellPki, makeCellPki, makeCsr } from '../helpers/cell-pki';
import { testCtx, type TestCtx } from '../helpers/ctx';

const META = { ip: '203.0.113.9' };
const GOOD = { siteName: 'Frederick Roof', lat: '39.414371', lon: '-77.410541', region: 'MD', piModel: 'pi5', w12Boards: '1', gps: true, antenna: 'Vertical', backhaul: 'home', power: 'mains', contactPhone: '+13015550100', agree: true, agreementVersion: 1 };

let pki: CellPki;
let fixture: string;

/** A tiny release tree, packed as oc-deploy packs one. */
function packRelease(dir: string, o: { cert?: boolean; main?: boolean } = {}): string {
  const tree = mkdtempSync(join(dir, 'tree-'));
  mkdirSync(join(tree, 'oc-cell'));
  mkdirSync(join(tree, 'dist/systemd/system.conf.d'), { recursive: true });
  if (o.main !== false) writeFileSync(join(tree, 'oc-cell/occ_main.c'), 'int main(void) { return 0; }\n');
  writeFileSync(join(tree, 'oc-cell/occ_cfg.h'), o.cert === false ? '/* no tls */\n' : '/* cert = /etc/opencell/cell.crt */\n');
  writeFileSync(join(tree, 'dist/systemd/oc-cell.service'), '[Service]\n');
  writeFileSync(join(tree, 'dist/systemd/system.conf.d/10-opencell-cpus.conf'), '[Manager]\n');
  const out = join(dir, `rel-${tree.slice(-6)}.tgz`);
  execFileSync('tar', ['-czf', out, '-C', tree, '.']);
  return out;
}

beforeAll(() => {
  pki = makeCellPki();
  fixture = packRelease(pki.dir);
});
afterAll(() => pki.done());

let ctx: TestCtx;
let nodeId: number;
let token: string;
let cellId: number;

function setupCtx(env: Record<string, string> = {}) {
  const c = testCtx({ OC_CELL_CA_CERT: pki.icaCrt, OC_CELL_CA_KEY: pki.icaKey, OC_CORE_CA: pki.rootCrt, OC_RELEASE_DIR: mkdtempSync(join(tmpdir(), 'oc-rel-')), ...env });
  return c;
}

async function approved(c: TestCtx): Promise<{ nodeId: number; cellId: number }> {
  const root = c.db.insert(users).values({ name: 'Root', email: 'root@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  c.db.insert(userRoles).values({ userId: root, role: 'admin', grantedAt: 1 }).run();
  const alice = c.db.insert(users).values({ name: 'Alice', email: 'alice@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  const req = submitRequest(c, alice, GOOD, META);
  if (!req.ok) throw new Error(req.error);
  const a = await approveRequest(c, root, req.id, { coreId: 'fake', anchor: 30, boardRole: 'bs' }, META);
  if (!a.ok) throw new Error(a.error);
  return a;
}

const req = (path: string, init: RequestInit = {}) => new Request(`https://portal.test${path}`, init);
const postCsr = (t: string, csr: string, headers: Record<string, string> = {}) => handleCsr(ctx, t, req(`/setup/${t}/csr`, { method: 'POST', body: csr, headers: { origin: 'https://portal.test', 'x-oc-client-ip': META.ip, ...headers } }));

beforeEach(async () => {
  ctx = setupCtx();
  publishRelease(ctx, fixture, 'v0.2.0');
  ({ nodeId, cellId } = await approved(ctx));
  token = makeSetupToken(ctx, nodeId, null).token;
});

function parseBundle(text: string) {
  const parts: Record<string, string> = {};
  let name = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('--- ')) {
      name = line.slice(4);
      parts[name] = '';
    } else if (name) parts[name] += `${line}\n`;
  }
  return parts;
}

describe('publishing a release', () => {
  it('copies the tarball in and remembers its hash', () => {
    const c = setupCtx();
    const r = publishRelease(c, fixture, 'v0.2.0');
    expect(r.tag).toBe('v0.2.0');
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.sha256).toBe(execFileSync('sha256sum', [fixture]).toString().split(' ')[0]);
    expect(currentRelease(c)).toMatchObject({ tag: 'v0.2.0', sha256: r.sha256, bytes: r.bytes, path: expect.stringContaining('oc-cell-v0.2.0.tgz') });
    expect(readFileSync(currentRelease(c)!.path).equals(readFileSync(fixture))).toBe(true);
    expect(c.db.select().from(audit).where(eq(audit.action, 'cell.release')).all()).toHaveLength(1);
  });

  it.each(['v1', '1.2.3', 'v1.2.3/../x', "v1.2.3'"])('refuses a tag like %j', (tag) => {
    expect(() => publishRelease(setupCtx(), fixture, tag)).toThrow(/tag/);
  });

  it('refuses a tarball without the TLS link (PI-1), or without oc-cell', () => {
    expect(() => publishRelease(setupCtx(), packRelease(pki.dir, { cert: false }), 'v0.2.0')).toThrow(/cert/);
    expect(() => publishRelease(setupCtx(), packRelease(pki.dir, { main: false }), 'v0.2.0')).toThrow(/occ_main/);
    const notTar = join(pki.dir, 'not.tgz');
    writeFileSync(notTar, 'hello');
    expect(() => publishRelease(setupCtx(), notTar, 'v0.2.0')).toThrow();
  });

  it('keeps the current release and the one before', () => {
    const c = setupCtx();
    publishRelease(c, fixture, 'v0.1.0');
    publishRelease(c, fixture, 'v0.2.0');
    publishRelease(c, fixture, 'v0.3.0');
    expect(currentRelease(c)?.tag).toBe('v0.3.0');
    const files = execFileSync('ls', [c.config.releaseDir]).toString().trim().split('\n');
    expect(files).toEqual(['oc-cell-v0.2.0.tgz', 'oc-cell-v0.3.0.tgz']);
  });

  it('has a CLI', () => {
    const c = setupCtx();
    expect(runAdmin(c, ['cell-release'])).toMatchObject({ code: 0, out: expect.stringContaining('no release') });
    expect(runAdmin(c, ['cell-release', fixture, 'v0.2.0'])).toMatchObject({ code: 0, out: expect.stringContaining('v0.2.0') });
    expect(runAdmin(c, ['cell-release'])).toMatchObject({ code: 0, out: expect.stringContaining('v0.2.0') });
    expect(runAdmin(c, ['cell-release', fixture, 'nope']).code).toBe(1);
    expect(runAdmin(c, ['cell-release', fixture]).code).toBe(2);
  });
});

describe('the script and the tarball', () => {
  it('serves the script as plain text, with no cache, and uses nothing', async () => {
    const r = await handleScript(ctx, token, req(`/setup/${token}`));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const text = await r.text();
    expect(text).toContain(`TOKEN='${token}'`);
    expect(text).toContain(`SHA256='${currentRelease(ctx)!.sha256}'`);
    expect((await handleScript(ctx, token, req(`/setup/${token}`))).status).toBe(200);
    expect(ctx.db.select().from(setupTokens).where(eq(setupTokens.id, hashToken(token))).get()?.usedAt).toBeNull();
  });

  it('serves the tarball', async () => {
    const r = await handleTarball(ctx, token, req(`/setup/${token}/oc-cell.tgz`));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/gzip');
    const body = Buffer.from(await r.arrayBuffer());
    expect(r.headers.get('content-length')).toBe(String(body.length));
    expect(body.equals(readFileSync(fixture))).toBe(true);
  });

  it('answers a token’s state with one line', async () => {
    const bad = 'x'.repeat(43);
    expect((await handleScript(ctx, bad, req(`/setup/${bad}`))).status).toBe(404);
    expect((await handleTarball(ctx, bad, req(`/setup/${bad}/oc-cell.tgz`))).status).toBe(404);
    expect((await handleScript(ctx, 'nope', req('/setup/nope'))).status).toBe(404);
    const fresh = makeSetupToken(ctx, nodeId, null).token;
    expect((await handleScript(ctx, token, req(`/setup/${token}`))).status).toBe(410);
    ctx.clock.t += SETUP_TOKEN_MS;
    const r = await handleScript(ctx, fresh, req(`/setup/${fresh}`));
    expect(r.status).toBe(410);
    expect((await r.text()).trim().split('\n')).toHaveLength(1);
  });

  it('says so when no release is published', async () => {
    const c = setupCtx();
    const ids = await approved(c);
    const t = makeSetupToken(c, ids.nodeId, null).token;
    expect((await handleScript(c, t, req(`/setup/${t}`))).status).toBe(503);
    expect((await handleTarball(c, t, req(`/setup/${t}/oc-cell.tgz`))).status).toBe(503);
  });

  it('says so when no certificates can be issued', async () => {
    const c = testCtx({ OC_RELEASE_DIR: mkdtempSync(join(tmpdir(), 'oc-rel-')) });
    publishRelease(c, fixture, 'v0.2.0');
    const ids = await approved(c);
    const t = makeSetupToken(c, ids.nodeId, null).token;
    const r = await handleScript(c, t, req(`/setup/${t}`));
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("Certificates aren't available right now");
  });

  it.each(['next-action'])('refuses a %s header', async (h) => {
    expect((await handleScript(ctx, token, req(`/setup/${token}`, { headers: { [h]: 'x' } }))).status).toBe(400);
    expect((await handleTarball(ctx, token, req(`/setup/${token}/oc-cell.tgz`, { headers: { [h]: 'x' } }))).status).toBe(400);
  });

  it('a browser with a session can read the script ("inspect first")', async () => {
    const r = await handleScript(ctx, token, req(`/setup/${token}`, { headers: { cookie: `${ctx.config.sessionCookie}=abc` } }));
    expect(r.status).toBe(200);
  });
});

describe('a CSR with the token', () => {
  it('gets the bundle: a leaf chaining to the root through the intermediate, pinned on the core', async () => {
    const { csr } = makeCsr(pki, { subj: '/CN=i-am-root' });
    const r = await postCsr(token, csr);
    expect(r.status).toBe(200);
    const parts = parseBundle(await r.text());
    expect(Object.keys(parts)).toEqual(['oc-cell.crt', 'ca.crt', 'oc-cell.conf']);
    expect(parts['oc-cell.crt'].match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(parts['ca.crt']).toBe(readFileSync(pki.rootCrt, 'utf8'));
    expect(parts['oc-cell.conf']).toContain(`cell_id = ${cellId}\n`);
    expect(parts['oc-cell.conf']).toContain('core = cells.fake.invalid:7443\n');
    expect(parts['oc-cell.conf']).toContain('sync_ch = 30\n');
    const leafFile = join(pki.dir, `leaf-${Date.now()}.pem`);
    writeFileSync(leafFile, parts['oc-cell.crt']);
    const leaf = new X509Certificate(parts['oc-cell.crt']);
    expect(leaf.subject).toMatch(new RegExp(`^O=OpenCell\nCN=cell${cellId}-md-\\d+$`));
    expect(pki.ossl('verify', '-purpose', 'sslclient', '-CAfile', pki.rootCrt, '-untrusted', leafFile, leafFile)).toContain('OK');
    const fpr = leaf.fingerprint256.replaceAll(':', '').toLowerCase();
    expect((await ctx.core.cellStatus(0, cellId))[0].certFpr).toBe(fpr);
    expect(ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()).toMatchObject({ certFpr: fpr, certIssuedAt: ctx.clock.t, certExpiresAt: new Date(leaf.validTo).getTime() });
    expect(ctx.db.select().from(issuedCerts).all()).toEqual([expect.objectContaining({ nodeId, fpr, pinned: true, cn: expect.stringMatching(new RegExp(`^cell${cellId}-md-\\d+$`)) })]);
    expect(ctx.db.select().from(nodeState).where(eq(nodeState.nodeId, nodeId)).get()).toMatchObject({ online: null, onlineSince: null, offlineSince: null });
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'node.cert')).all()).toHaveLength(1);
    expect(ctx.core.audit.filter((a) => a.op === 'cell.set_cert').at(-1)?.actor).toBe(ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()!.userId);
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ to: 'alice@example.org', subject: expect.stringContaining('certificate') });
  });

  it('a second POST finds it used', async () => {
    const { csr } = makeCsr(pki);
    expect((await postCsr(token, csr)).status).toBe(200);
    expect((await postCsr(token, csr)).status).toBe(410);
    expect(ctx.core.audit.filter((a) => a.op === 'cell.set_cert')).toHaveLength(1);
  });

  it('two POSTs at once: one certificate, one pin', async () => {
    const { csr } = makeCsr(pki);
    const rs = await Promise.all([postCsr(token, csr), postCsr(token, csr)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(ctx.core.audit.filter((a) => a.op === 'cell.set_cert')).toHaveLength(1);
    expect(ctx.db.select().from(issuedCerts).all()).toHaveLength(1);
  });

  it('after 24 h it is gone', async () => {
    ctx.clock.t += SETUP_TOKEN_MS;
    expect((await postCsr(token, makeCsr(pki).csr)).status).toBe(410);
  });

  it('a core that does not answer: 503, the certificate logged as not pinned, and the token works again', async () => {
    const { csr } = makeCsr(pki);
    ctx.core.simDown('refuse');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await postCsr(token, csr);
    log.mockRestore();
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("The network didn't answer");
    expect(ctx.db.select().from(issuedCerts).all()).toEqual([expect.objectContaining({ pinned: false })]);
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'node.cert_unpinned')).all()).toHaveLength(1);
    expect(ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()?.certFpr).toBeNull();
    ctx.core.simDown(null);
    expect((await postCsr(token, csr)).status).toBe(200);
    expect(ctx.db.select().from(issuedCerts).all().map((c) => c.pinned).sort()).toEqual([false, true]);
  });

  it.each([
    ['RSA', () => makeCsr(pki, { newkey: ['rsa:2048'] }).csr],
    ['P-384', () => makeCsr(pki, { newkey: ['ec', '-pkeyopt', 'ec_paramgen_curve:P-384'] }).csr],
    ['garbage', () => 'hello'],
    ['two blocks', () => makeCsr(pki).csr + makeCsr(pki).csr],
  ])('%s: 400, and the token still works', async (_w, csr) => {
    expect((await postCsr(token, csr())).status).toBe(400);
    expect(ctx.db.select().from(issuedCerts).all()).toEqual([]);
    expect((await postCsr(token, makeCsr(pki).csr)).status).toBe(200);
  });

  it('a body over 4096 bytes: 400', async () => {
    expect((await postCsr(token, 'x'.repeat(5000))).status).toBe(400);
    expect((await postCsr(token, makeCsr(pki).csr)).status).toBe(200);
  });

  it('a CA:TRUE request gets a plain leaf', async () => {
    const r = await postCsr(token, makeCsr(pki, { addext: ['basicConstraints=critical,CA:TRUE'] }).csr);
    expect(r.status).toBe(200);
    expect(new X509Certificate(parseBundle(await r.text())['oc-cell.crt']).ca).toBe(false);
  });

  it('five tries at a token, then no more', async () => {
    for (let i = 0; i < 5; i++) expect((await postCsr(token, 'hello')).status).toBe(400);
    expect((await postCsr(token, makeCsr(pki).csr)).status).toBe(410);
  });

  it('a Next-Action header or a session cookie: 400, and the token is untouched', async () => {
    const { csr } = makeCsr(pki);
    expect((await postCsr(token, csr, { 'next-action': 'abc' })).status).toBe(400);
    expect((await postCsr(token, csr, { cookie: `${ctx.config.sessionCookie}=abc` })).status).toBe(400);
    expect((await postCsr(token, csr)).status).toBe(200);
  });

  it('an unknown token: 404; no CA configured: 503', async () => {
    expect((await postCsr('x'.repeat(43), makeCsr(pki).csr)).status).toBe(404);
    const c = testCtx({ OC_RELEASE_DIR: mkdtempSync(join(tmpdir(), 'oc-rel-')) });
    publishRelease(c, fixture, 'v0.2.0');
    const ids = await approved(c);
    const t = makeSetupToken(c, ids.nodeId, null).token;
    const saved = ctx;
    ctx = c;
    const r = await postCsr(t, makeCsr(pki).csr);
    ctx = saved;
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("Certificates aren't available right now");
  });

  it('an unfit intermediate: 503, and nothing is signed', async () => {
    const bad = pki.makeIca({ pathlen: 1 });
    const c = setupCtx({ OC_CELL_CA_CERT: bad.crt, OC_CELL_CA_KEY: bad.key });
    publishRelease(c, fixture, 'v0.2.0');
    const ids = await approved(c);
    const t = makeSetupToken(c, ids.nodeId, null).token;
    const saved = ctx;
    ctx = c;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await postCsr(t, makeCsr(pki).csr);
    log.mockRestore();
    ctx = saved;
    expect(r.status).toBe(503);
    expect(c.db.select().from(issuedCerts).all()).toEqual([]);
  });

  it('is limited per address', async () => {
    setLimit(ctx, 'setup_ip', 1);
    expect((await postCsr(token, 'hello')).status).toBe(400);
    expect((await postCsr(token, 'hello')).status).toBe(429);
  });

  it('a disabled operator, or none: 410 on the script and the CSR, and nothing is re-pinned', async () => {
    const owner = ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()!.userId!;
    ctx.db.update(users).set({ disabledAt: 1 }).where(eq(users.id, owner)).run();
    expect((await handleScript(ctx, token, req(`/setup/${token}`))).status).toBe(410);
    expect((await postCsr(token, makeCsr(pki).csr)).status).toBe(410);
    ctx.db.update(users).set({ disabledAt: null }).where(eq(users.id, owner)).run();
    ctx.db.update(nodes).set({ userId: null }).where(eq(nodes.id, nodeId)).run();
    expect((await postCsr(token, makeCsr(pki).csr)).status).toBe(410);
    expect(ctx.core.audit.filter((a) => a.op === 'cell.set_cert')).toEqual([]);
  });

  it('a revoked node: 410', async () => {
    ctx.db.update(nodes).set({ revokedAt: 1 }).where(eq(nodes.id, nodeId)).run();
    expect((await postCsr(token, makeCsr(pki).csr)).status).toBe(410);
  });

  it('the NOC site has no setup', async () => {
    const noc = testCtx({ OC_SITE: 'noc' });
    expect((await handleScript(noc, token, req(`/setup/${token}`))).status).toBe(404);
  });
});
