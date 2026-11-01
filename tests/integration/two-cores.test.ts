import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TlsCore } from '@/core/tls-client';
import { exchanges, npas, users } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';
import { coreStatuses } from '@/lib/core-status';
import { auditEnd, networkActivity } from '@/lib/noc/activity';
import { networkSnapshot, summarize } from '@/lib/noc/snapshot';
import { blockOf, homeCoreOf, refreshBlocks } from '@/lib/numbers/blocks';
import { accountCalls } from '@/lib/numbers/calls';
import { forgetGetting, getNumber, listNumbers, reissueNumber, syncDue } from '@/lib/numbers/ownership';
import { clearQrFlash } from '@/lib/numbers/qr-flash';
import { offerMissingNpas } from '@/lib/numbers/route-delegate';
import { CORE_DIR, type CoreCert, freePort, makeCoreCert, makeRouteTable, makeTestPki, type RealCore, type RouteTable, startRealCore, type TestPki } from '../helpers/real-core';

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
    // Sorted by index: the order of core.blocks is not part of its contract (core v0.7.0 sorts by prefix).
    expect((await c1.core.coreBlocks(7)).sort((a, b) => a.index - b.index)).toEqual([
      { index: 1, homeCore: 1, role: 'home', prefix: '8831717' },
      { index: 2, homeCore: 2, role: 'none', prefix: '8831503' },
    ]);
    expect(await c2.core.coreBlocks(7)).toEqual([
      { index: 2, homeCore: 2, role: 'home', prefix: '8831503' },
      { index: 1, homeCore: 1, role: 'none', prefix: '8831717' },
    ]);
  });

  it("gives the NOC both cores' radios, OCSS links and blocks, asked as the portal itself (plan N2a)", async () => {
    await peerState(c1, 2, (s) => s === 'up');
    const snap = await networkSnapshot(ctx);
    expect(snap.cores.map((c) => c.radio)).toEqual([
      { state: 'ok', value: [] },
      { state: 'ok', value: [] },
    ]);
    expect(snap.cores[0].ocss).toMatchObject({ state: 'ok', value: [{ coreId: 2, state: 'up' }] });
    expect(snap.cores[1].ocss).toMatchObject({ state: 'ok', value: [{ coreId: 1, state: 'up' }] });
    expect(snap.cores[1].blocks).toMatchObject({ state: 'ok', value: [{ prefix: '8831503', role: 'home' }, { prefix: '8831717', role: 'none' }] });
    expect(summarize(snap).attention.filter((a) => a.text.startsWith('OCSS'))).toEqual([]);
    for (const op of ['cell.radio', 'ocss.status', 'core.blocks']) expect(audit(c1)).toContain(`a0 ${op} ok`);
  });

  it("reads both cores' calls and audit as the portal itself, and finds where each audit ends (plan N2a)", async () => {
    const snap = await networkSnapshot(ctx);
    const a = await networkActivity(ctx, snap);
    expect(a.cores.map((c) => [c.id, c.calls.state, c.registrations.state])).toEqual([
      ['core1', 'ok', 'ok'],
      ['core2', 'ok', 'ok'],
    ]);
    expect(a.cores[0].calls).toMatchObject({ value: { total: 0 }, complete: true });
    expect(a.cores[0].registrations).toMatchObject({ value: { total: 0 } });
    const end = auditEnd(ctx, 'core1');
    expect(end).toBeGreaterThan(0);
    const newest = await c1.core.auditList(7, { after: end! - 1, limit: 5 });
    expect(newest[0].id).toBe(end);
    expect(audit(c1)).toContain('a0 cdr.recent ok');
    expect(audit(c1)).toContain('a0 audit.list ok');
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
    const after = await networkSnapshot(ctx);
    expect(summarize(after).attention.map((a) => a.text)).toContainEqual(expect.stringMatching(/^OCSS from core1 to core 2: (down|connecting|handshake|open)/));
  });
});

// Portal P5: the portal and two real cores on a signed table (OCSS spec §3,
// §5): every number operation on its block's home core, learned from core.blocks.
describe.skipIf(!CORE_DIR)('two real cores on a signed table (P5)', () => {
  let pki: TestPki & { done: () => void };
  let table: RouteTable;
  let c1: RealCore;
  let c2: RealCore;
  let ctx: Ctx;
  let ada: { id: string; userId: number };
  let certs: CoreCert[] = [];
  const meta = { ip: '192.0.2.10' };
  const EAST = '+883160646401000';
  const WEST = '+883150322201000';
  const audit = (c: RealCore) => execFileSync(`${CORE_DIR}/build/oc/oc-core`, ['admin', '--socket', c.adminSocket, 'audit', '50']).toString();

  beforeAll(async () => {
    pki = makeTestPki();
    certs = [makeCoreCert(pki), makeCoreCert(pki)];
    table = makeRouteTable(['606,US-KY', '503,US-OR', '865,US-TN', '212,US-NY', '415,US-CA'], ['--pin', '606=1', '--pin', '503=2', '--pin', '865=3']);
    const port = await freePort();
    const ocss = (n: 0 | 1) => [`ocss_cert = ${certs[n].crt}`, `ocss_key = ${certs[n].key}`, `ocss_ca = ${pki.caCrt}`];
    c1 = await startRealCore(CORE_DIR, { pki, coreId: 1, name: 'oc-core-t1', block: '8831606 1', cert: certs[0], table, extra: ['api_rate = route.offer 3600 50', `peer = 2 127.0.0.1:${port} ${certs[1].fpr}`, ...ocss(0)] });
    c2 = await startRealCore(CORE_DIR, { pki, coreId: 2, name: 'oc-core-t2', block: '8831503 2', cert: certs[1], table, extra: ['api_rate = route.offer 3600 50', `peer = 1 - ${certs[0].fpr}`, `ocss_listen = 127.0.0.1:${port}`, ...ocss(1)] });
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
    vi.resetModules();
    const { createCtx } = await import('@/lib/ctx');
    ctx = createCtx();
    clearQrFlash();
    forgetGetting();
    const now = Date.now();
    for (const [npa, region, stateCode] of [['606', 'KY', 'US-KY'], ['503', 'OR', 'US-OR']]) ctx.db.insert(npas).values({ npa, region, stateCode, geographic: true, inService: true, updatedAt: now }).run();
    for (const [npa, nxx, region] of [['606', '464', 'KY'], ['503', '222', 'OR']]) {
      ctx.db.insert(exchanges).values({ npaNxx: npa + nxx, npa, nxx, region, rateCenter: 'TEST', firstSeenAt: now }).run();
    }
    ada = { id: 's-ada', userId: ctx.db.insert(users).values({ name: 'ada', email: 'ada@example.org', emailVerifiedAt: 1, numberLimit: 5, createdAt: 1 }).returning().get().id };
  }, 60_000);

  afterAll(async () => {
    for (const h of ctx?.cores ?? []) (h.core as TlsCore).close();
    delete (globalThis as { __ocCores?: unknown }).__ocCores;
    vi.unstubAllEnvs();
    await c1?.done();
    await c2?.done();
    for (const c of certs) c.done();
    table?.done();
    pki?.done();
  });

  it('learns the homes from core.blocks, the handles from their ids', async () => {
    expect(ctx.cores.map((h) => h.coreNo)).toEqual([1, 2]);
    expect(await refreshBlocks(ctx)).toBe(true);
    expect(homeCoreOf(ctx, '606')).toBe(1);
    expect(homeCoreOf(ctx, '503')).toBe(2);
    expect(blockOf(ctx, '865')).toEqual({ homeCore: 1, index: 3 });
    expect(blockOf(ctx, '415')?.homeCore).toBe(2);
  });

  it('gets a West number on core 2 and not core 1; its status and calls are asked of its home', async () => {
    expect(await getNumber(ctx, ada, { number: WEST, listed: 'on' }, meta)).toMatchObject({ ok: true });
    expect(audit(c2)).toContain('sub.create ok');
    expect(audit(c1)).not.toContain('sub.create');
    expect(listNumbers(ctx, ada.userId)).toEqual([expect.objectContaining({ number: WEST, coreId: 'core2' })]);
    expect(await syncDue(ctx, ada.userId, 0)).toEqual([expect.objectContaining({ number: WEST, state: 'unactivated' })]);
    expect(audit(c2)).toContain('sub.status ok');
    expect(audit(c1)).not.toContain('sub.status');
    expect(await accountCalls(ctx, ada.userId)).toMatchObject({ calls: [], unavailable: [] });
    expect(audit(c2)).toContain('cdr.list ok');
    expect(audit(c1)).not.toContain('cdr.list');
  });

  it('gets an East number on core 1', async () => {
    expect(await getNumber(ctx, ada, { number: EAST, listed: 'on' }, meta)).toMatchObject({ ok: true });
    expect(audit(c1)).toContain('sub.create ok');
    expect(listNumbers(ctx, ada.userId).map((r) => [r.number, r.coreId])).toContainEqual([EAST, 'core1']);
  });

  it('reports the table on route.status (OCSS spec §5.2)', async () => {
    for (const c of [c1, c2]) {
      const st = await c.core.routeStatus(7);
      expect(st).toMatchObject({ signed: true, rootVersion: 1, seq: 0, blocks: 5, maxIdx: 5 });
      expect(st.delegateNotAfter).toBeGreaterThan(Date.now());
    }
  });

  // The whole P5 path: a new NPA, signed by the delegate as oc-route's table names it, taken by both real cores.
  it('a new NPA via offerMissingNpas shows in both cores, and a number in it can be got on its home core', async () => {
    const readKey = () => table.delegateKey;
    const now = Date.now();
    ctx.db.insert(npas).values({ npa: '206', region: 'WA', stateCode: 'US-WA', geographic: true, inService: true, updatedAt: now }).run();
    ctx.db.insert(exchanges).values({ npaNxx: '206222', npa: '206', nxx: '222', region: 'WA', rateCenter: 'SEATTLE', firstSeenAt: now }).run();
    // Every other block is here too, so only 206 is missing.
    for (const [npa, region, stateCode] of [['865', 'TN', 'US-TN'], ['212', 'NY', 'US-NY'], ['415', 'CA', 'US-CA']]) {
      ctx.db.insert(npas).values({ npa, region, stateCode, geographic: true, inService: true, updatedAt: now }).run();
    }
    expect(await offerMissingNpas(ctx, { readKey })).toEqual({ offered: ['206'], replayed: 0, errors: [] });
    for (const c of [c1, c2]) {
      expect(await c.core.routeStatus(7)).toMatchObject({ seq: 1, blocks: 6, maxIdx: 6 });
      expect((await c.core.coreBlocks(7)).find((b) => b.prefix === '8831206')).toMatchObject({ index: 6, homeCore: 2 });
    }
    expect((await c1.core.coreBlocks(7)).find((b) => b.prefix === '8831206')?.role).toBe('secondary');
    expect((await c2.core.coreBlocks(7)).find((b) => b.prefix === '8831206')?.role).toBe('home');
    await refreshBlocks(ctx);
    expect(blockOf(ctx, '206')).toEqual({ homeCore: 2, index: 6 });
    const N = '+883120622201000';
    expect(await getNumber(ctx, ada, { number: N, listed: 'on' }, meta)).toMatchObject({ ok: true });
    expect(listNumbers(ctx, ada.userId).map((r) => [r.number, r.coreId])).toContainEqual([N, 'core2']);
    expect(await c2.core.numCheck(7, N)).toBe('taken');
    // Nothing is missing now, and a byte-identical repeat is held, not new (rule 3).
    expect(await offerMissingNpas(ctx, { readKey })).toEqual({ offered: [], replayed: 0, errors: [] });
  });

  it('real cores refuse what the fake refuses: a signature, a seq, a used prefix (OCSS spec §3.5)', async () => {
    const { buildAddition, delegatePublicKey, signAddition } = await import('@/lib/numbers/route-delegate');
    const key = table.delegateKey;
    const delegate = delegatePublicKey(key);
    const st = await c1.core.routeStatus(7);
    const add = (seq: number, npa: string, index: number) => buildAddition({ rootVersion: 1, seq, issued: 1, delegate, blocks: [{ npa, index, state: 'US-NC' }] });
    const good = add(st.seq + 1, '472', st.maxIdx + 1);
    await expect(c1.core.routeOffer(7, 1, good, Buffer.alloc(64))).rejects.toMatchObject({ code: 'invalid', message: 'bad signature' });
    const gap = add(st.seq + 2, '472', st.maxIdx + 1);
    await expect(c1.core.routeOffer(7, 1, gap, signAddition(gap, key))).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('out of order') });
    expect(await c1.core.routeStatus(7)).toMatchObject({ seq: st.seq });
  });

  it('core 2 down: a West number fails plainly and nothing goes to core 1; East is untouched', async () => {
    await c2.done();
    const bob = { id: 's-bob', userId: ctx.db.insert(users).values({ name: 'bob', email: 'bob@example.org', emailVerifiedAt: 1, numberLimit: 5, createdAt: 1 }).returning().get().id };
    expect(await getNumber(ctx, bob, { number: '+883150322201001', listed: 'on' }, meta)).toMatchObject({ ok: false, error: expect.stringContaining("didn't answer") });
    expect(await reissueNumber(ctx, ada, WEST, meta)).toMatchObject({ ok: false, error: expect.stringContaining("didn't answer") });
    expect(audit(c1)).not.toContain('sub.create ok +883150322201001');
    expect(audit(c1)).not.toContain('sub.reissue');
    const rows = await syncDue(ctx, ada.userId, 0);
    expect(rows.find((r) => r.number === WEST)).toMatchObject({ state: 'unactivated' });
    expect(rows.find((r) => r.number === EAST)).toMatchObject({ state: 'unactivated' });
  }, 20_000);
});
