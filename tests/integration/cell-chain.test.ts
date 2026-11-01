import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userRoles, users } from '@/db/schema';
import { submitRequest } from '@/lib/nodes/requests';
import { approveRequest } from '@/lib/nodes/review';
import { issueForToken } from '@/lib/nodes/setup';
import { makeSetupToken } from '@/lib/nodes/setup-tokens';
import { setLimit } from '@/lib/ratelimit';
import { type CellPki, makeCellPki, makeCsr } from '../helpers/cell-pki';
import { testCtx, type TestCtx } from '../helpers/ctx';
import { FakeCell } from '../helpers/fake-cell';
import { CORE_DIR, makeTestPki, type RealCore, startRealCore, type TestPki } from '../helpers/real-core';

// The chain the plan's Global Constraints describe, against a real oc-core's TLS
// cell listener: a CSR through issueForToken, the portal pinning the leaf on the
// core over TLS, and a cell dialling with leaf + intermediate.

const META = { ip: '203.0.113.9' };
const GOOD = { siteName: 'Frederick Roof', lat: '39.414371', lon: '-77.410541', region: 'MD', piModel: 'pi5', w12Boards: '1', gps: true, antenna: 'Vertical', backhaul: 'home', power: 'mains', contactPhone: '+13015550100', agree: true, agreementVersion: 1 };

describe.skipIf(!CORE_DIR)('the cell certificate chain on a real oc-core', () => {
  let cellPki: CellPki;
  let pki: TestPki & { done: () => void };
  let core: RealCore;
  let ica: { crt: string; key: string };
  let ctx: TestCtx;
  let root: number;
  let alice: number;

  beforeAll(async () => {
    cellPki = makeCellPki();
    pki = makeTestPki();
    ica = cellPki.makeIca({ rootDir: pki.caDir, name: 'portal-ica' });
    core = await startRealCore(CORE_DIR, { pki, cellListen: true, extra: ['api_rate = cell.add 3600 100', 'api_rate = cell.set_cert 3600 100'] });
    ctx = testCtx({ OC_CELL_CA_CERT: ica.crt, OC_CELL_CA_KEY: ica.key, OC_CORE_CA: pki.caCrt });
    ctx.cores = [{ id: 'core1', where: `127.0.0.1:${core.port}`, coreNo: 1, cellAddr: `127.0.0.1:${core.cellPort}`, core: core.core }];
    root = ctx.db.insert(users).values({ name: 'Root', email: 'root@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
    ctx.db.insert(userRoles).values({ userId: root, role: 'admin', grantedAt: 1 }).run();
    alice = ctx.db.insert(users).values({ name: 'Alice', email: 'alice@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
    setLimit(ctx, 'node_request', 1000);
  }, 30_000);

  afterAll(async () => {
    await core?.done();
    pki?.done();
    cellPki?.done();
  });

  /** An approved node on the real core, and one certificate for it. */
  async function nodeWithCert(): Promise<{ nodeId: number; cellId: number; chain: string; leaf: string; key: string }> {
    const req = submitRequest(ctx, alice, GOOD, META);
    if (!req.ok) throw new Error(req.error);
    const a = await approveRequest(ctx, root, req.id, { coreId: 'core1', anchor: 3, boardRole: 'bs' }, META);
    if (!a.ok) throw new Error(a.error);
    const issued = await issue(a.nodeId);
    return { nodeId: a.nodeId, cellId: a.cellId, ...issued };
  }

  async function issue(nodeId: number): Promise<{ chain: string; leaf: string; key: string }> {
    const { csr, key } = makeCsr(cellPki);
    const r = await issueForToken(ctx, makeSetupToken(ctx, nodeId, null).token, csr, { ip: `198.51.100.${nodeId}` });
    expect(r.body.split('\n')[0], r.body).toBe('--- oc-cell.crt');
    expect(r.status).toBe(200);
    const chain = r.body.slice(r.body.indexOf('\n') + 1, r.body.indexOf('--- ca.crt'));
    const leaf = chain.slice(0, chain.indexOf('-----END CERTIFICATE-----') + 26);
    return { chain, leaf, key };
  }

  const dial = (cert: string, key: string, cellId: number) =>
    FakeCell.helloTls({ host: '127.0.0.1', port: core.cellPort!, servername: 'localhost', ca: readFileSync(pki.caCrt, 'utf8'), cert, key }, cellId);

  it('takes leaf + intermediate: HELLO_ACK, and the cell shows online', async () => {
    const n = await nodeWithCert();
    const fpr = execFileSync('openssl', ['x509', '-noout', '-fingerprint', '-sha256'], { input: n.leaf }).toString().split('=')[1].trim().replaceAll(':', '').toLowerCase();
    expect((await core.core.cellStatus(0, n.cellId))[0].certFpr).toBe(fpr);
    const cell = await dial(n.chain, n.key, n.cellId);
    try {
      await expect.poll(async () => (await core.core.cellStatus(0, n.cellId))[0].online, { timeout: 5000 }).toBe(true);
    } finally {
      cell.close();
    }
  });

  it('refuses the leaf alone: the chain does not reach the root', async () => {
    const n = await nodeWithCert();
    await expect(dial(n.leaf, n.key, n.cellId)).rejects.toThrow();
    expect((await core.core.cellStatus(0, n.cellId))[0].online).toBe(false);
  });

  it('refuses a leaf from an intermediate the root did not sign', async () => {
    const n = await nodeWithCert();
    const foreign = testCtx({ OC_CELL_CA_CERT: cellPki.icaCrt, OC_CELL_CA_KEY: cellPki.icaKey });
    const { loadCellCa, signCellCert } = await import('@/lib/ca/cell-ca');
    const ca = loadCellCa(foreign)!;
    const { csr, key } = makeCsr(cellPki);
    const signed = await signCellCert(ca, csr, 'cell1-rogue');
    // The core's pin for this cell is even made to agree: the chain alone must refuse it.
    await core.core.cellSetCert(0, n.cellId, signed.fpr);
    await expect(dial(signed.pem + ca.certPem, key, n.cellId)).rejects.toThrow();
  });

  it('refuses a good chain whose pin was replaced (the --new-key flow)', async () => {
    const n = await nodeWithCert();
    const newer = await issue(n.nodeId);
    await expect(dial(n.chain, n.key, n.cellId)).rejects.toThrow(/HELLO refused|closed the link/);
    const cell = await dial(newer.chain, newer.key, n.cellId);
    cell.close();
  });

  it('refuses it after cell.revoke', async () => {
    const n = await nodeWithCert();
    await core.core.cellRevoke(0, n.cellId);
    await expect(dial(n.chain, n.key, n.cellId)).rejects.toThrow(/HELLO refused|closed the link/);
  });

  it('a cell revoked at the core while a CSR is in flight: the real core refuses the pin, so no bundle', async () => {
    const req = submitRequest(ctx, alice, GOOD, META);
    if (!req.ok) throw new Error(req.error);
    const a = await approveRequest(ctx, root, req.id, { coreId: 'core1', anchor: 3, boardRole: 'bs' }, META);
    if (!a.ok) throw new Error(a.error);
    const token = makeSetupToken(ctx, a.nodeId, null).token;
    // The core has it; the portal's row has not caught up.
    await core.core.cellRevoke(0, a.cellId);
    const r = await issueForToken(ctx, token, makeCsr(cellPki).csr, { ip: '198.51.100.200' });
    expect(r.status).toBe(410);
    expect(r.body).not.toContain('BEGIN CERTIFICATE');
    expect((await core.core.cellStatus(0, a.cellId))[0]).toMatchObject({ revoked: true, certFpr: null });
  });

  it('with cell_issuers, takes the listed intermediate and refuses another, as production will', async () => {
    const fingerprint = (crt: string) => execFileSync('openssl', ['x509', '-in', crt, '-noout', '-fingerprint', '-sha256']).toString().split('=')[1].trim().replaceAll(':', '').toLowerCase();
    const strict = await startRealCore(CORE_DIR, { pki, cellListen: true, extra: [`cell_issuers = root,${fingerprint(ica.crt)}`] });
    const other = cellPki.makeIca({ rootDir: pki.caDir, name: 'portal-ica-2' });
    try {
      const { loadCellCa, signCellCert } = await import('@/lib/ca/cell-ca');
      const cellId = await strict.core.cellAdd(1, 'strict', 'part15', 0);
      const listed = loadCellCa(testCtx({ OC_CELL_CA_CERT: ica.crt, OC_CELL_CA_KEY: ica.key }))!;
      const unlisted = loadCellCa(testCtx({ OC_CELL_CA_CERT: other.crt, OC_CELL_CA_KEY: other.key }))!;
      const a = makeCsr(cellPki);
      const good = await signCellCert(listed, a.csr, 'cell1-strict');
      const b = makeCsr(cellPki);
      const bad = await signCellCert(unlisted, b.csr, 'cell1-strict');
      const hello = (cert: string, key: string) => FakeCell.helloTls({ host: '127.0.0.1', port: strict.cellPort!, servername: 'localhost', ca: readFileSync(pki.caCrt, 'utf8'), cert, key }, cellId);
      await strict.core.cellSetCert(1, cellId, bad.fpr);
      await expect(hello(bad.pem + unlisted.certPem, b.key)).rejects.toThrow();
      await strict.core.cellSetCert(1, cellId, good.fpr);
      const cell = await hello(good.pem + listed.certPem, a.key);
      cell.close();
    } finally {
      await strict.done();
    }
  });
});
