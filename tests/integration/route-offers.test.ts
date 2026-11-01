import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCore } from '@/core/fake';
import { type CoreBlock, CoreError, type CoreHandle } from '@/core/types';
import { npas, routeAdditions } from '@/db/schema';
import { runAdminAsync } from '@/lib/admin-cli';
import { listAudit } from '@/lib/audit';
import { recentRefreshes } from '@/lib/numbers/nanpa-refresh';
import { delegatePublicKey, offerMissingNpas } from '@/lib/numbers/route-delegate';
import { type TestCtx, testCtx } from '../helpers/ctx';

const KEY = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const readKey = () => KEY;
const DAY = 86400_000;
const TABLE: CoreBlock[] = [
  { index: 1, homeCore: 1, role: 'home', prefix: '8831606' },
  { index: 2, homeCore: 2, role: 'none', prefix: '8831503' },
];

let base: TestCtx;
let core1: FakeCore;
let core2: FakeCore;
let ctx: TestCtx;

function table(c: FakeCore, status: Record<string, unknown> = {}) {
  c.simBlocks(TABLE, { signed: true, rootVersion: 7, seq: 0, maxIdx: 454, delegateNotAfter: base.now() + 200 * DAY, ...status });
}

beforeEach(() => {
  base = testCtx();
  core1 = new FakeCore(base.now, { coreId: 1 });
  core2 = new FakeCore(base.now, { coreId: 2 });
  table(core1);
  table(core2);
  const cores: CoreHandle[] = [
    { id: 'core1', where: 'a', coreNo: 1, core: core1 },
    { id: 'core2', where: 'b', coreNo: 2, core: core2 },
  ];
  ctx = { ...base, cores };
  for (const [npa, region, stateCode] of [['606', 'KY', 'US-KY'], ['503', 'OR', 'US-OR']]) addNpa(npa, region, stateCode);
});

afterEach(() => vi.restoreAllMocks());

function addNpa(npa: string, region: string, stateCode: string | null, over: { geographic?: boolean; inService?: boolean } = {}) {
  base.db.insert(npas).values({ npa, region, stateCode, geographic: true, inService: true, updatedAt: 1, ...over }).run();
}
/** `n` new NPAs in North Carolina: 220, 222, 224, … (N11 never comes up). */
const many = (n: number) => Array.from({ length: n }, (_, i) => String(220 + i * 2)).forEach((c) => addNpa(c, 'NC', 'US-NC'));
const held = () => base.db.select().from(routeAdditions).all();
const prefixes = async (c: FakeCore) => (await c.coreBlocks(0)).map((b) => b.prefix);

describe('offerMissingNpas (OCSS spec §5.4)', () => {
  it('offers a new NPA to every core at seq S+1, index max_idx+1; it comes out homed by its state', async () => {
    addNpa('472', 'NC', 'US-NC');
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r).toEqual({ offered: ['472'], replayed: 0, errors: [] });
    for (const c of [core1, core2]) {
      expect(await c.routeStatus(0)).toMatchObject({ rootVersion: 7, seq: 1, blocks: 3, maxIdx: 455 });
      expect((await c.coreBlocks(0)).at(-1)).toMatchObject({ index: 455, homeCore: 1, prefix: '8831472' });
    }
    expect(core1.audit.filter((a) => a.op === 'route.offer').map((a) => a.actor)).toEqual([0]);
  });

  it('a West NPA is homed on core 2, secondary core 1', async () => {
    addNpa('206', 'WA', 'US-WA');
    await offerMissingNpas(ctx, { readKey });
    expect((await core1.coreBlocks(0)).at(-1)).toMatchObject({ homeCore: 2, role: 'secondary', prefix: '8831206' });
    expect((await core2.coreBlocks(0)).at(-1)).toMatchObject({ homeCore: 2, role: 'home', prefix: '8831206' });
  });

  it('keeps each addition: blob, signature, NPAs; audited, without the key', async () => {
    addNpa('472', 'NC', 'US-NC');
    await offerMissingNpas(ctx, { readKey });
    const [row] = held();
    expect(row).toMatchObject({ rootVersion: 7, seq: 1, npas: '["472"]', createdAt: base.now() });
    expect(row.blob.subarray(0, 4).toString('latin1')).toBe('OCRA');
    expect(row.blob.subarray(15, 47).equals(delegatePublicKey(KEY))).toBe(true);
    expect(row.sig).toHaveLength(64);
    expect(listAudit(base, 1)[0]).toMatchObject({ action: 'route.addition', target: 'route:7.1' });
  });

  it('with nothing missing it offers nothing, and signs nothing', async () => {
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r).toEqual({ offered: [], replayed: 0, errors: [] });
    expect(held()).toEqual([]);
    expect(core1.audit.some((a) => a.op === 'route.offer')).toBe(false);
  });

  it('a second run finds the NPA in core.blocks: decision 3 is the difference, not "new this week"', async () => {
    addNpa('472', 'NC', 'US-NC');
    await offerMissingNpas(ctx, { readKey });
    expect(await offerMissingNpas(ctx, { readKey })).toEqual({ offered: [], replayed: 0, errors: [] });
    expect(held()).toHaveLength(1);
  });

  it('offers only geographic, in-service NPAs with a known state code', async () => {
    addNpa('800', '', null, { geographic: false });
    addNpa('273', 'QC', 'CA-QC', { inService: false });
    addNpa('999', '', null);
    expect(await offerMissingNpas(ctx, { readKey })).toEqual({ offered: [], replayed: 0, errors: [] });
    ctx.db.update(npas).set({ inService: true }).where(eq(npas.npa, '273')).run();
    expect((await offerMissingNpas(ctx, { readKey })).offered).toEqual(['273']); // it went in service later
  });

  it('a state code in neither list is reported and left out: it would refuse the whole addition', async () => {
    addNpa('472', 'NC', 'US-NC');
    addNpa('473', 'ZZ', 'US-ZZ');
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.offered).toEqual(['472']);
    expect(r.errors).toEqual([expect.stringMatching(/473.*US-ZZ/)]);
  });

  it('20 new NPAs: two additions of 16 and 4 in one run, indexes rising', async () => {
    many(20);
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.offered).toHaveLength(20);
    expect(held().map((h) => [h.seq, JSON.parse(h.npas).length])).toEqual([[1, 16], [2, 4]]);
    expect(await core1.routeStatus(0)).toMatchObject({ seq: 2, blocks: 22, maxIdx: 474 });
    const idx = (await core2.coreBlocks(0)).slice(2).map((b) => b.index);
    expect(idx).toEqual(Array.from({ length: 20 }, (_, i) => 455 + i));
  });

  it('at most 2 additions a run (route.offer is 10/h, burst 2): 40 take 2 runs, 70 take 3', async () => {
    many(40);
    expect((await offerMissingNpas(ctx, { readKey })).offered).toHaveLength(32);
    expect(core1.audit.filter((a) => a.op === 'route.offer')).toHaveLength(2);
    expect((await offerMissingNpas(ctx, { readKey })).offered).toHaveLength(8);
    expect(await core1.routeStatus(0)).toMatchObject({ seq: 3, blocks: 42 });
    expect((await offerMissingNpas(ctx, { readKey })).offered).toEqual([]);

    Array.from({ length: 30 }, (_, i) => String(300 + i * 2)).filter((c) => !c.endsWith('11')).forEach((c) => addNpa(c, 'NC', 'US-NC'));
    expect((await offerMissingNpas(ctx, { readKey })).offered).toHaveLength(30); // 16 + 14
  });

  it('70 at once: 32, 32, then 6', async () => {
    many(70);
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push((await offerMissingNpas(ctx, { readKey })).offered.length);
    expect(runs).toEqual([32, 32, 6, 0]);
  });

  it('a core behind gets the additions it lacks, in order, and nothing new is signed', async () => {
    addNpa('472', 'NC', 'US-NC');
    const real = core2.routeOffer.bind(core2);
    core2.routeOffer = async () => {
      throw new CoreError('unavailable', 'the core did not answer in time');
    };
    await offerMissingNpas(ctx, { readKey });
    expect(await core2.routeStatus(0)).toMatchObject({ seq: 0 });
    core2.routeOffer = real;
    addNpa('473', 'NC', 'US-NC');
    const before = core1.audit.filter((a) => a.op === 'route.offer').length;
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r).toEqual({ offered: [], replayed: 1, errors: [] });
    expect(await core2.routeStatus(0)).toMatchObject({ seq: 1 });
    expect(await prefixes(core2)).toContain('8831472');
    expect(held()).toHaveLength(1);
    expect(core1.audit.filter((a) => a.op === 'route.offer')).toHaveLength(before);
    // Level again: the next run signs the new one.
    expect((await offerMissingNpas(ctx, { readKey })).offered).toEqual(['473']);
    expect(await core2.routeStatus(0)).toMatchObject({ seq: 2 });
  });

  it('a core that falls behind twice is replayed each time, and the chain goes on in between', async () => {
    many(70);
    const real = core2.routeOffer.bind(core2);
    core2.routeOffer = async () => {
      throw new CoreError('rate_limited', 'over the limit');
    };
    await offerMissingNpas(ctx, { readKey }); // seq 1 reaches core 1 only, and the run stops
    expect(await core1.routeStatus(0)).toMatchObject({ seq: 1 });
    core2.routeOffer = real;
    await offerMissingNpas(ctx, { readKey }); // replay
    await offerMissingNpas(ctx, { readKey }); // 2, 3
    core2.routeOffer = async () => {
      throw new CoreError('rate_limited', 'over the limit');
    };
    await offerMissingNpas(ctx, { readKey }); // 4 reaches core 1 only
    core2.routeOffer = real;
    expect(await core1.routeStatus(0)).toMatchObject({ seq: 4 });
    expect(await core2.routeStatus(0)).toMatchObject({ seq: 3 });
    expect(await offerMissingNpas(ctx, { readKey })).toMatchObject({ replayed: 1, offered: [] });
  });

  it('caps a replay at 2 offers a core a run', async () => {
    many(70);
    await offerMissingNpas(ctx, { readKey });
    await offerMissingNpas(ctx, { readKey }); // 4 additions on both
    const c3 = new FakeCore(base.now, { coreId: 3 });
    table(c3);
    const three = { ...ctx, cores: [...ctx.cores, { id: 'core3', where: 'c', coreNo: 3, core: c3 }] };
    const r = await offerMissingNpas(three, { readKey });
    expect(r).toEqual({ offered: [], replayed: 2, errors: [] });
    expect(await c3.routeStatus(0)).toMatchObject({ seq: 2 });
    expect((await offerMissingNpas(three, { readKey })).replayed).toBe(2);
    expect(await c3.routeStatus(0)).toMatchObject({ seq: 4 });
  });

  it('one core invalid: the error names it, the run stops; the next run repeats safely and nothing is signed twice', async () => {
    many(20);
    const real = core2.routeOffer.bind(core2);
    core2.routeOffer = async () => {
      throw new CoreError('invalid', 'rule: index taken');
    };
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.errors).toEqual([expect.stringMatching(/^core2: route\.offer 7\.1: invalid: rule: index taken$/)]);
    expect(r.offered).toHaveLength(16); // core 1 took them
    expect(held().map((h) => h.seq)).toEqual([1]);
    const again = await offerMissingNpas(ctx, { readKey });
    expect(again.errors).toEqual([expect.stringMatching(/^core2: route\.offer 7\.1: invalid/)]);
    expect(held().map((h) => h.seq)).toEqual([1]);
    core2.routeOffer = real;
    expect(await offerMissingNpas(ctx, { readKey })).toEqual({ offered: [], replayed: 1, errors: [] });
    expect((await core2.routeStatus(0)).seq).toBe(1);
  });

  it('`taken` on one core is the same: named, held, repeated', async () => {
    addNpa('472', 'NC', 'US-NC');
    core1.routeOffer = async () => {
      throw new CoreError('taken', 'seq 1 holds another addition');
    };
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.errors).toEqual(['core1: route.offer 7.1: taken: seq 1 holds another addition']);
    expect(held()).toHaveLength(1);
    expect((await core2.routeStatus(0)).seq).toBe(1);
  });

  it('an addition every core refused as invalid goes, so a corrected key can sign that seq: none of them holds it', async () => {
    addNpa('472', 'NC', 'US-NC');
    const refuse = async () => {
      throw new CoreError('invalid', 'no valid delegation');
    };
    const [r1, r2] = [core1.routeOffer.bind(core1), core2.routeOffer.bind(core2)];
    core1.routeOffer = refuse;
    core2.routeOffer = refuse;
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.offered).toEqual([]);
    expect(r.errors).toEqual([
      'core1: route.offer 7.1: invalid: no valid delegation',
      'core2: route.offer 7.1: invalid: no valid delegation',
      '7.1: every core refused it; not kept',
    ]);
    expect(held()).toEqual([]);
    core1.routeOffer = r1;
    core2.routeOffer = r2;
    expect((await offerMissingNpas(ctx, { readKey })).offered).toEqual(['472']);
  });

  it('every core unreachable as it offers: kept and replayed, never signed again for that seq', async () => {
    addNpa('472', 'NC', 'US-NC');
    const [r1, r2] = [core1.routeOffer.bind(core1), core2.routeOffer.bind(core2)];
    const fail = async () => {
      throw new CoreError('unavailable', 'gone');
    };
    core1.routeOffer = fail;
    core2.routeOffer = fail;
    const first = await offerMissingNpas(ctx, { readKey });
    expect(first.offered).toEqual([]);
    expect(first.errors).toHaveLength(2);
    const blob = held()[0].blob;
    core1.routeOffer = r1;
    core2.routeOffer = r2;
    expect(await offerMissingNpas(ctx, { readKey })).toEqual({ offered: [], replayed: 2, errors: [] });
    expect(held()).toHaveLength(1);
    expect(held()[0].blob.equals(blob)).toBe(true);
    expect((await core1.routeStatus(0)).seq).toBe(1);
  });

  it('a core unreachable: an error and no new addition this run', async () => {
    addNpa('472', 'NC', 'US-NC');
    core2.simDown('refuse');
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.offered).toEqual([]);
    expect(r.errors).toEqual([expect.stringMatching(/^core2: route\.status: unavailable/)]);
    expect(held()).toEqual([]);
    expect(core1.audit.some((a) => a.op === 'route.offer')).toBe(false);
  });

  it('a core unreachable does not stop the other being caught up', async () => {
    addNpa('472', 'NC', 'US-NC');
    const real = core2.routeOffer.bind(core2);
    core2.routeOffer = async () => {
      throw new CoreError('unavailable', 'gone');
    };
    await offerMissingNpas(ctx, { readKey });
    core2.routeOffer = real;
    core1.simDown('refuse');
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.replayed).toBe(1);
    expect(r.errors).toEqual([expect.stringMatching(/^core1: route\.status/)]);
    expect((await core2.routeStatus(0)).seq).toBe(1);
  });

  it('an unsigned core: an error and no new addition', async () => {
    addNpa('472', 'NC', 'US-NC');
    core2.simBlocks(TABLE, { signed: false, rootVersion: 0 });
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.errors).toEqual(['core2: runs no signed table']);
    expect(held()).toEqual([]);
  });

  it('a core on an older root version: an error, and no new addition', async () => {
    addNpa('472', 'NC', 'US-NC');
    table(core2, { rootVersion: 6 });
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.errors).toEqual(['core2: on root table 6, another core on 7']);
    expect(held()).toEqual([]);
  });

  it('an addition on another root version is ignored; the new root starts its chain at 1', async () => {
    addNpa('472', 'NC', 'US-NC');
    await offerMissingNpas(ctx, { readKey });
    table(core1, { rootVersion: 8, seq: 0, maxIdx: 455 });
    table(core2, { rootVersion: 8, seq: 0, maxIdx: 455 });
    const r = await offerMissingNpas(ctx, { readKey }); // 472 is back to missing in this test's table
    expect(r.offered).toEqual(['472']);
    expect(held().map((h) => [h.rootVersion, h.seq])).toEqual([[7, 1], [8, 1]]);
    expect((await core1.coreBlocks(0)).at(-1)).toMatchObject({ index: 456 });
  });

  it('a core ahead of the portal is an error, never overwritten', async () => {
    addNpa('472', 'NC', 'US-NC');
    await offerMissingNpas(ctx, { readKey }); // holds 7.1
    table(core1, { seq: 3 });
    table(core2, { seq: 3 });
    addNpa('473', 'NC', 'US-NC');
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.offered).toEqual([]);
    expect(r.errors.join('\n')).toMatch(/at 7\.3, ahead of the portal \(it holds up to 7\.1\)/);
    expect(held()).toHaveLength(1);
  });

  it('holding nothing on this root, with the cores agreed, it goes on from their seq', async () => {
    table(core1, { seq: 3 });
    table(core2, { seq: 3 });
    addNpa('472', 'NC', 'US-NC');
    expect((await offerMissingNpas(ctx, { readKey })).offered).toEqual(['472']);
    expect(held().map((h) => h.seq)).toEqual([4]);
  });

  it('a core behind, with the addition not held here: an error, nothing new', async () => {
    table(core1, { seq: 3 });
    table(core2, { seq: 1 });
    addNpa('472', 'NC', 'US-NC');
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r).toMatchObject({ offered: [], replayed: 0 });
    expect(r.errors).toEqual(['core2: at 7.1 and needs 7.2, which the portal does not hold']);
  });

  it('no delegate key: nothing new, the error says so, replays still go', async () => {
    addNpa('472', 'NC', 'US-NC');
    const none = await offerMissingNpas(ctx, { readKey: () => null });
    expect(none).toEqual({ offered: [], replayed: 0, errors: ['no delegate key'] });
    expect(held()).toEqual([]);

    const real = core2.routeOffer.bind(core2);
    core2.routeOffer = async () => {
      throw new CoreError('unavailable', 'gone');
    };
    await offerMissingNpas(ctx, { readKey });
    core2.routeOffer = real;
    expect(await offerMissingNpas(ctx, { readKey: () => null })).toEqual({ offered: [], replayed: 1, errors: ['no delegate key'] });
  });

  it.each([
    ['garbage', () => 'not a key'],
    ['the wrong kind of key', () => generateKeyPairSync('x25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()],
    ['a reader that throws', () => {
      throw new Error('EACCES');
    }],
  ])('an unusable key is no key: %s', async (_w, bad) => {
    addNpa('472', 'NC', 'US-NC');
    expect(await offerMissingNpas(ctx, { readKey: bad })).toEqual({ offered: [], replayed: 0, errors: ['no delegate key'] });
  });

  it('a delegation that ends within 30 days adds an error line each run, and it still offers', async () => {
    table(core1, { delegateNotAfter: base.now() + 10 * DAY });
    table(core2, { delegateNotAfter: base.now() + 10 * DAY });
    addNpa('472', 'NC', 'US-NC');
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.offered).toEqual(['472']);
    expect(r.errors).toEqual([expect.stringMatching(/^the delegation ends \d{4}-\d{2}-\d{2}: renew it with a new root version$/)]);
    expect((await offerMissingNpas(ctx, { readKey })).errors).toHaveLength(1);
  });

  it('no delegation or an ended one: an error, and nothing signed that every core would refuse', async () => {
    addNpa('472', 'NC', 'US-NC');
    table(core1, { delegateNotAfter: null });
    const a = await offerMissingNpas(ctx, { readKey });
    expect(a.errors).toEqual(['core1: its table names no valid delegation']);
    table(core1, { delegateNotAfter: base.now() - 1 });
    expect((await offerMissingNpas(ctx, { readKey })).errors).toEqual(['core1: its table names no valid delegation']);
    expect(held()).toEqual([]);
  });

  it('the block table failing: an error, nothing signed', async () => {
    addNpa('472', 'NC', 'US-NC');
    core1.coreBlocks = async () => {
      throw new CoreError('rate_limited', 'x');
    };
    core2.coreBlocks = core1.coreBlocks;
    const r = await offerMissingNpas(ctx, { readKey });
    expect(r.errors).toEqual(['core.blocks: no core answered']);
    expect(held()).toEqual([]);
  });

  it('one handle: the same, with that core alone', async () => {
    const one = { ...ctx, cores: [ctx.cores[0]] };
    addNpa('472', 'NC', 'US-NC');
    expect((await offerMissingNpas(one, { readKey })).offered).toEqual(['472']);
    expect((await core1.routeStatus(0)).seq).toBe(1);
  });

  it('the key never appears in anything a run says', async () => {
    const lines: unknown[][] = [];
    for (const m of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, m).mockImplementation((...a) => void lines.push(a));
    addNpa('472', 'NC', 'US-NC');
    core2.routeOffer = async () => {
      throw new CoreError('invalid', 'bad signature');
    };
    const r = await offerMissingNpas(ctx, { readKey });
    const r2 = await offerMissingNpas(ctx, { readKey: () => KEY.replace('PRIVATE', 'PUBLIC') });
    const b64 = KEY.split('\n').slice(1, -2).join('');
    const said = JSON.stringify([r, r2, lines, listAudit(base, 50), held().map((h) => [h.npas, h.blob.toString('hex'), h.sig.toString('hex')])]);
    expect(said).not.toContain(b64);
    expect(said).not.toContain(Buffer.from(b64, 'base64').toString('hex'));
    expect(said).not.toContain(Buffer.from(b64, 'base64').subarray(-32).toString('hex'));
  });
});

describe('oc-portal-admin nanpa-refresh', () => {
  const FIX = 'tests/fixtures/nanpa';
  /** `dir` with one NPA more than the fixture: 472, in service in North Carolina. */
  function dirWith472() {
    const dir = mkdtempSync(join(tmpdir(), 'ocp-offers-'));
    for (const f of ['co-codes.txt', 'cnac.csv', 'rc_PA.xml']) writeFileSync(join(dir, f), readFileSync(join(FIX, f)));
    writeFileSync(join(dir, 'npas.csv'), `${readFileSync(join(FIX, 'npas.csv'), 'utf8').trimEnd()}\r\n472,General Purpose Code,Yes,,No,Yes,01-Jan-2020,G,NC,US,Y\r\n`);
    return dir;
  }
  /** Every NPA in the fixture as a block, so only 472 is missing. */
  function tableForFixture(c: FakeCore) {
    const rows = readFileSync(join(FIX, 'npas.csv'), 'utf8').split(/\r?\n/).slice(2).filter(Boolean);
    const blocks: CoreBlock[] = rows.map((l, i) => ({ index: i + 1, homeCore: 1, role: 'none', prefix: `8831${l.split(',')[0]}` }));
    c.simBlocks(blocks, { signed: true, rootVersion: 1, seq: 0, delegateNotAfter: base.now() + 200 * DAY });
  }
  function keyFile() {
    const f = join(mkdtempSync(join(tmpdir(), 'ocp-key-')), 'route-delegate.key');
    writeFileSync(f, KEY, { mode: 0o600 });
    return f;
  }
  function withEnv(env: Record<string, string>) {
    const t = testCtx(env);
    return { ...t, cores: [{ id: 'core1', where: 'a', coreNo: 1, core: core1 }, { id: 'core2', where: 'b', coreNo: 2, core: core2 }] };
  }

  beforeEach(() => {
    tableForFixture(core1);
    tableForFixture(core2);
  });

  it('imports, then offers what is missing, and logs it for the admin page', async () => {
    const t = withEnv({ OC_ROUTE_DELEGATE_KEY: keyFile() });
    const r = await runAdminAsync(t, ['nanpa-refresh', '--dir', dirWith472()]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/new exchanges/);
    expect(r.out).toContain('route: offered NPAs 472');
    expect(await prefixes(core1)).toContain('8831472');
    expect(await prefixes(core2)).toContain('8831472');
    expect(recentRefreshes(t, 1)[0].summary).toContain('offered NPAs 472');
  });

  it('a key by credential name resolves in $CREDENTIALS_DIRECTORY', async () => {
    const f = keyFile();
    vi.stubEnv('CREDENTIALS_DIRECTORY', join(f, '..'));
    try {
      const t = withEnv({ OC_ROUTE_DELEGATE_KEY: 'route-delegate.key' });
      const r = await runAdminAsync(t, ['nanpa-refresh', '--dir', dirWith472()]);
      expect(r.out).toContain('route: offered NPAs 472');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['not configured', {}],
    ['not there', { OC_ROUTE_DELEGATE_KEY: '/nonexistent/route-delegate.key' }],
  ])('no key (%s): the import is unaffected, the log says so, it exits normally', async (_w, env) => {
    const t = withEnv(env);
    const r = await runAdminAsync(t, ['nanpa-refresh', '--dir', dirWith472()]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/new exchanges/);
    expect(r.out).toContain('route: no delegate key');
    expect(t.db.select().from(npas).where(eq(npas.npa, '472')).get()).toMatchObject({ stateCode: 'US-NC' });
    expect(await prefixes(core1)).not.toContain('8831472');
    const [log] = recentRefreshes(t, 1);
    expect(log.ok).toBe(true);
    expect(log.summary).toContain('no delegate key');
  });

  it('a failed import offers nothing', async () => {
    const t = withEnv({ OC_ROUTE_DELEGATE_KEY: keyFile() });
    const dir = dirWith472();
    writeFileSync(join(dir, 'co-codes.txt'), 'nonsense\r\n');
    expect((await runAdminAsync(t, ['nanpa-refresh', '--dir', dir])).code).toBe(1);
    expect(await prefixes(core1)).not.toContain('8831472');
  });

  it('an offer blowing up does not fail a good import', async () => {
    const t = withEnv({ OC_ROUTE_DELEGATE_KEY: keyFile() });
    const boom = { ...t, db: t.db };
    core1.routeStatus = () => {
      throw new TypeError('bug');
    };
    const r = await runAdminAsync(boom, ['nanpa-refresh', '--dir', dirWith472()]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/new exchanges/);
    expect(r.out).toContain('route: core1: route.status: TypeError');
  });

  it('the refresh log failing does not fail a good import', async () => {
    const t = withEnv({ OC_ROUTE_DELEGATE_KEY: keyFile() });
    const log = await import('@/lib/numbers/nanpa-refresh');
    const dir = dirWith472();
    t.db.$client.exec(`CREATE TRIGGER no_offers BEFORE UPDATE ON nanpa_refreshes BEGIN SELECT RAISE(ABORT, 'locked'); END`);
    const r = await runAdminAsync(t, ['nanpa-refresh', '--dir', dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('route: the refresh log was not updated');
    expect(log.recentRefreshes(t, 1)[0].ok).toBe(true);
  });

  it('the NOC site offers nothing', async () => {
    const t = withEnv({ OC_SITE: 'noc', OC_ROUTE_DELEGATE_KEY: keyFile() });
    expect(await runAdminAsync(t, ['nanpa-refresh', '--dir', dirWith472()])).toMatchObject({ code: 0, out: expect.stringMatching(/nothing to do/) });
    expect(core1.audit.some((a) => a.op === 'route.status')).toBe(false);
  });
});
