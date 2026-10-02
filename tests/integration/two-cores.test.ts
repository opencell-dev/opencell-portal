import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TlsCore } from '@/core/tls-client';
import type { Ctx } from '@/lib/ctx';
import { coreStatuses } from '@/lib/core-status';
import { networkSnapshot, summarize } from '@/lib/noc/snapshot';
import { CORE_DIR, makeTestPki, type RealCore, startRealCore, type TestPki } from '../helpers/real-core';

// Plan P4b: the portal and two real oc-core processes, configured as
// production is (OC_CORES=core1,core2 in the environment, the process's own
// context): one OpenCell CA, the same portal certificate pinned on both.
describe.skipIf(!CORE_DIR)('two real cores (OC_CORES)', () => {
  let pki: TestPki & { done: () => void };
  let c1: RealCore;
  let c2: RealCore;
  let ctx: Ctx;

  const audit = (c: RealCore) =>
    execFileSync(`${CORE_DIR}/build/oc/oc-core`, ['admin', '--socket', c.adminSocket, 'audit', '20']).toString();

  beforeAll(async () => {
    pki = makeTestPki();
    c1 = await startRealCore(CORE_DIR, { pki, coreId: 1, name: 'oc-core-t1', block: '8831717 1' });
    c2 = await startRealCore(CORE_DIR, { pki, coreId: 2, name: 'oc-core-t2', block: '8831503 2' });
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
  });
});
