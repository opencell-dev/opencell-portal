import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TlsCore } from '@/core/tls-client';
import type { Ctx } from '@/lib/ctx';
import { coreStatuses } from '@/lib/core-status';
import { networkSnapshot, summarize } from '@/lib/noc/snapshot';
import { CORE_DIR, type CoreCert, freePort, makeCoreCert, makeTestPki, type RealCore, startRealCore, type TestPki } from '../helpers/real-core';

// Plan P4b: the portal and two real oc-core processes, configured as
// production is (OC_CORES=core1,core2 in the environment, the process's own
// context): one OpenCell CA, the same portal certificate pinned on both.
describe.skipIf(!CORE_DIR)('two real cores (OC_CORES)', () => {
  let pki: TestPki & { done: () => void };
  let c1: RealCore;
  let c2: RealCore;
  let ctx: Ctx;
  let certs: CoreCert[] = [];
  let ocssPort: number;

  const audit = (c: RealCore) =>
    execFileSync(`${CORE_DIR}/build/oc/oc-core`, ['admin', '--socket', c.adminSocket, 'audit', '20']).toString();

  beforeAll(async () => {
    pki = makeTestPki();
    // Joined by OCSS as production is (core test services spec §7.1): core 1, the lower id, dials core 2.
    certs = [makeCoreCert(pki), makeCoreCert(pki)];
    ocssPort = await freePort();
    const ocss = (n: 0 | 1) => [`ocss_cert = ${certs[n].crt}`, `ocss_key = ${certs[n].key}`, `ocss_ca = ${pki.caCrt}`];
    c1 = await startRealCore(CORE_DIR, {
      pki,
      coreId: 1,
      name: 'oc-core-t1',
      block: '8831717 1',
      cert: certs[0],
      extra: ['block = 8831503 2 2', `peer = 2 127.0.0.1:${ocssPort} ${certs[1].fpr}`, ...ocss(0)],
    });
    c2 = await startRealCore(CORE_DIR, {
      pki,
      coreId: 2,
      name: 'oc-core-t2',
      block: '8831503 2',
      cert: certs[1],
      extra: ['block = 8831717 1 1', `peer = 1 - ${certs[0].fpr}`, `ocss_listen = 127.0.0.1:${ocssPort}`, ...ocss(1)],
    });
    const env = {
      OC_ORIGIN: 'https://portal.test',
      OC_RP_ID: 'portal.test',
      OC_SECRET: 'test-secret-test-secret-test-secret-0123',
      OC_DB_PATH: ':memory:',
      OC_MAIL: 'outbox',
      OC_CORE: 'tls',
      OC_CORES: 'core1,core2',
      OC_CORE_CORE1_ADDR: `127.0.0.1:${c1.port}`,
      OC_CORE_CORE1_NAME: 'localhost',
      OC_CORE_CORE2_ADDR: `127.0.0.1:${c2.port}`,
      OC_CORE_CORE2_NAME: 'localhost',
      OC_CORE_CA: pki.caCrt,
      OC_CORE_CERT: pki.portalCrt,
      OC_CORE_KEY: pki.portalKey,
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    delete (globalThis as { __ocCores?: unknown }).__ocCores;
    vi.resetModules(); // config() and getCores() are made once per module instance
    const { createCtx } = await import('@/lib/ctx');
    ctx = createCtx();
  }, 60_000);

  afterAll(async () => {
    for (const h of ctx?.cores ?? []) (h.core as TlsCore).close();
    delete (globalThis as { __ocCores?: unknown }).__ocCores;
    vi.unstubAllEnvs();
    await c1?.done();
    await c2?.done();
    for (const c of certs) c.done();
    pki?.done();
  });

  it('shows both cores on the dashboard, each by its own name', async () => {
    const rows = await coreStatuses(ctx, 7);
    expect(rows.map((r) => [r.id, r.status?.coreId, r.status?.name])).toEqual([
      ['core1', 1, 'oc-core-t1'],
      ['core2', 2, 'oc-core-t2'],
    ]);
    expect(audit(c1)).toContain('a7 core.status ok');
    expect(audit(c2)).toContain('a7 core.status ok');
  });

  it('sends number and subscriber operations to core 1 only', async () => {
    const qr = await ctx.core.subCreate(4242, '+883171746412345');
    expect(qr.number).toBe('+883171746412345');
    expect(audit(c1)).toContain('a4242 sub.create ok');
    expect(audit(c2)).not.toContain('sub.create');
    const [s1, s2] = await coreStatuses(ctx, 7);
    expect(s2.status?.subscribers).toBe(0);
    expect(s1.status).not.toBeNull();
  });

  it("gives the NOC both cores' status and cells, asked as the portal itself (NOC design §5)", async () => {
    const id = await ctx.core.cellAdd(7, 'NOC test 1', 'part97', 3);
    const snap = await networkSnapshot(ctx);
    expect(snap.cores.map((c) => [c.id, c.status?.name])).toEqual([
      ['core1', 'oc-core-t1'],
      ['core2', 'oc-core-t2'],
    ]);
    expect(snap.cores[0].cells?.find((c) => c.cellId === id)).toMatchObject({ name: 'NOC test 1', mode: 'part97', group: 3, online: false });
    expect(snap.cores[1].cells).toEqual([]);
    expect(summarize(snap)).toMatchObject({ coresUp: 2, coresTotal: 2 });
    expect(audit(c1)).toContain('a0 core.status ok');
    expect(audit(c1)).toContain('a0 cell.status ok');
  });

  /** core `c`'s OCSS row for `peer` once it is `want` (the dial and handshake take a moment), or as it is after 6 s. */
  async function peerState(c: RealCore, peer: number, want: (s: string | undefined) => boolean) {
    for (let i = 0; ; i++) {
      const p = (await c.core.ocssStatus(7)).find((x) => x.coreId === peer);
      if (want(p?.state) || i >= 60) return p;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('shows the OCSS link up from both sides, and each core\'s blocks (NOC design §7.1)', async () => {
    expect(await peerState(c1, 2, (s) => s === 'up')).toMatchObject({ coreId: 2, dials: true, state: 'up', calls: 0, address: `127.0.0.1:${ocssPort}` });
    expect(await peerState(c2, 1, (s) => s === 'up')).toMatchObject({ coreId: 1, dials: false, state: 'up', calls: 0, address: null });
    expect(await c1.core.coreBlocks(7)).toEqual([
      { index: 1, homeCore: 1, role: 'home', prefix: '8831717' },
      { index: 2, homeCore: 2, role: 'none', prefix: '8831503' },
    ]);
    expect(await c2.core.coreBlocks(7)).toEqual([
      { index: 2, homeCore: 2, role: 'home', prefix: '8831503' },
      { index: 1, homeCore: 1, role: 'none', prefix: '8831717' },
    ]);
  });

  it('shows a core that stopped as unreachable, and the other as before', async () => {
    await c2.done();
    const t0 = Date.now();
    const rows = await coreStatuses(ctx, 7);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(rows[0].status?.name).toBe('oc-core-t1');
    expect(rows[1].status).toBeNull();
    const t1 = Date.now();
    const snap = await networkSnapshot(ctx);
    expect(Date.now() - t1).toBeLessThan(6000);
    expect(snap.cores[1]).toMatchObject({ id: 'core2', status: null, cells: null });
    expect(summarize(snap).attention[0]).toMatchObject({ severity: 'critical', core: 'core2' });
    expect((await peerState(c1, 2, (s) => s !== 'up'))?.state).not.toBe('up');
  });
});
