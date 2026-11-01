import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCore } from '@/core/fake';
import { makeCores } from '@/core';
import { type CoreBlock, type CoreHandle, CoreError } from '@/core/types';
import { numbers, npas, users } from '@/db/schema';
import { startHousekeeping } from '@/lib/housekeeping';
import { changeSubscriber } from '@/lib/noc/changes';
import { lookupNumber } from '@/lib/noc/lookup';
import { blockOf, homeCoreOf, refreshBlocks } from '@/lib/numbers/blocks';
import { accountCalls } from '@/lib/numbers/calls';
import { sideOfHome } from '@/lib/numbers/homing';
import { applyNanpa, readNanpaDir } from '@/lib/numbers/nanpa-refresh';
import { forgetGetting, getNumber, reissueNumber, releaseNumber, syncNumber } from '@/lib/numbers/ownership';
import { clearQrFlash } from '@/lib/numbers/qr-flash';
import { exchangeOffered, searchPlaces } from '@/lib/numbers/places';
import { coreFor, unreachableHandle } from '@/lib/numbers/route';
import { parseConfig } from '@/config';
import { testCtx } from '../helpers/ctx';

const WEST = '+883150355501000';
const EAST = '+883160655501000';
const TABLE: CoreBlock[] = [
  { index: 1, homeCore: 1, role: 'home', prefix: '8831606' },
  { index: 2, homeCore: 2, role: 'secondary', prefix: '8831503' },
  { index: 3, homeCore: 1, role: 'home', prefix: '8831717' },
];

/** Two fake cores, as OC_CORES=core1,core2: both report `TABLE`. */
function twoCores(table: CoreBlock[] = TABLE) {
  const base = testCtx();
  const core1 = new FakeCore(base.now, { coreId: 1 });
  const core2 = new FakeCore(base.now, { coreId: 2 });
  core1.simBlocks(table);
  core2.simBlocks(table.map((b) => ({ ...b, role: b.homeCore === 2 ? 'home' : 'secondary' })));
  const cores: CoreHandle[] = [
    { id: 'core1', where: 'a', coreNo: 1, core: core1 },
    { id: 'core2', where: 'b', coreNo: 2, core: core2 },
  ];
  const ctx = { ...base, cores, core: core1 };
  return { ctx, core1, core2 };
}

function npa(ctx: { db: ReturnType<typeof testCtx>['db'] }, code: string, region: string, geographic = true) {
  ctx.db.insert(npas).values({ npa: code, region, geographic, inService: true, updatedAt: 1 }).run();
}

/** The state rule's table: enough for what these tests ask. */
function rule(ctx: { db: ReturnType<typeof testCtx>['db'] }) {
  npa(ctx, '606', 'KY');
  npa(ctx, '503', 'OR');
  npa(ctx, '717', 'PA');
  npa(ctx, '500', '', false);
}

describe('CoreHandle.coreNo', () => {
  const env = { OC_ORIGIN: 'https://p.test', OC_RP_ID: 'p.test', OC_SECRET: 'x'.repeat(32) };
  const tls = (cores: string) => {
    const per = Object.fromEntries(cores.split(',').flatMap((id) => [[`OC_CORE_${id.toUpperCase()}_ADDR`, '127.0.0.1:1'], [`OC_CORE_${id.toUpperCase()}_NAME`, 'x']]));
    return parseConfig({ ...env, OC_CORE: 'tls', OC_CORES: cores, OC_CORE_CA: 'a', OC_CORE_CERT: 'b', OC_CORE_KEY: 'c', ...per });
  };
  it('core<N> is N, whatever its position', () => {
    expect(makeCores(tls('core2,core1')).map((h) => [h.id, h.coreNo])).toEqual([['core2', 2], ['core1', 1]]);
  });
  it('a TLS id without a trailing number is its position + 1', () => {
    expect(makeCores(tls('east,core2')).map((h) => [h.id, h.coreNo])).toEqual([['east', 1], ['core2', 2]]);
  });
  it('a fake core is its position + 1', () => {
    expect(makeCores(parseConfig({ ...env, OC_FAKE_CORES: '3' })).map((h) => [h.id, h.coreNo])).toEqual([['fake', 1], ['fake2', 2], ['fake3', 3]]);
  });
});

describe('sideOfHome', () => {
  it('core 1 is East, any other West', () => {
    expect(sideOfHome(1)).toBe('east');
    expect(sideOfHome(2)).toBe('west');
    expect(sideOfHome(3)).toBe('west');
  });
});

describe('the block table and coreFor (OCSS spec §5.3)', () => {
  it('sends a number to its home core, from core.blocks', async () => {
    const { ctx } = twoCores();
    expect(await refreshBlocks(ctx)).toBe(true);
    expect(coreFor(ctx, WEST).id).toBe('core2');
    expect(coreFor(ctx, EAST).id).toBe('core1');
    expect(coreFor(ctx, '+8831503555').id).toBe('core2'); // an exchange too (the shortlist)
    expect(homeCoreOf(ctx, '503')).toBe(2);
    expect(blockOf(ctx, '503')).toEqual({ homeCore: 2, index: 2 });
    expect(blockOf(ctx, '999')).toBeNull();
  });

  it('the table beats the state rule: a table moving 606 to core 2 wins', async () => {
    const { ctx } = twoCores([{ index: 1, homeCore: 2, role: 'secondary', prefix: '8831606' }]);
    rule(ctx);
    await refreshBlocks(ctx);
    expect(coreFor(ctx, EAST).id).toBe('core2');
    expect(homeCoreOf(ctx, '606')).toBe(2);
  });

  it('with no table the state rule answers (east → 1, west → 2)', () => {
    const { ctx } = twoCores();
    rule(ctx);
    expect(blockOf(ctx, '606')).toBeNull();
    expect(coreFor(ctx, EAST).id).toBe('core1');
    expect(coreFor(ctx, WEST).id).toBe('core2');
  });

  it('a block the table lacks falls to the rule (an NPA not offered yet: the core will say so)', async () => {
    const { ctx } = twoCores();
    rule(ctx);
    npa(ctx, '206', 'WA');
    await refreshBlocks(ctx);
    expect(coreFor(ctx, '+883120655501000').id).toBe('core2');
  });

  it('one handle takes every number, West too, without asking anything', async () => {
    const ctx = testCtx();
    const spy = vi.spyOn(ctx.core, 'coreBlocks');
    expect(coreFor(ctx, WEST)).toBe(ctx.cores[0]);
    expect(coreFor(ctx, EAST)).toBe(ctx.cores[0]);
    expect(coreFor(ctx, 'garbage')).toBe(ctx.cores[0]);
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).not.toHaveBeenCalled();
  });

  it('an unknown NPA with two handles is unavailable, without touching a core', async () => {
    const { ctx, core1, core2 } = twoCores();
    await refreshBlocks(ctx);
    const [a1, a2] = [core1.audit.length, core2.audit.length];
    const h = coreFor(ctx, '+883129955501000');
    await expect(h.core.subCreate(0, '+883129955501000')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(h.core.numFree(0, '+8831299555', 8)).rejects.toBeInstanceOf(CoreError);
    expect([core1.audit.length, core2.audit.length]).toEqual([a1, a2]);
  });

  it('a home with no handle is unavailable too, never another core', async () => {
    const { ctx, core1, core2 } = twoCores([{ index: 9, homeCore: 3, role: 'none', prefix: '8831208' }]);
    await refreshBlocks(ctx);
    const [a1, a2] = [core1.audit.length, core2.audit.length];
    const h = coreFor(ctx, '+883120855501000');
    expect(h.id).toBe('core3');
    await expect(h.core.subStatus(0, '+883120855501000')).rejects.toMatchObject({ code: 'unavailable' });
    expect([core1.audit.length, core2.audit.length]).toEqual([a1, a2]);
  });

  it('an unreachable handle looks like a down core: not fake, not a thenable', async () => {
    const h = unreachableHandle('core9');
    expect(h).toMatchObject({ id: 'core9' });
    await expect(Promise.resolve(h.core)).resolves.toBe(h.core);
    await expect(h.core.coreStatus(0)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('refreshBlocks falls through a down first core to the second; false when none answers', async () => {
    const { ctx, core1, core2 } = twoCores();
    core1.simDown('refuse');
    expect(await refreshBlocks(ctx)).toBe(true);
    expect(blockOf(ctx, '503')).toEqual({ homeCore: 2, index: 2 });
    core2.simDown('refuse');
    expect(await refreshBlocks(ctx)).toBe(false);
  });

  it('an empty answer is no answer: the next core is asked', async () => {
    const { ctx, core1 } = twoCores();
    core1.simBlocks([]);
    expect(await refreshBlocks(ctx)).toBe(true);
    expect(blockOf(ctx, '503')).toEqual({ homeCore: 2, index: 2 });
  });

  it('a stale table keeps answering while a refresh fails', async () => {
    const { ctx, core1, core2 } = twoCores([{ index: 1, homeCore: 2, role: 'none', prefix: '8831606' }]);
    await refreshBlocks(ctx);
    core1.simDown('refuse');
    core2.simDown('refuse');
    ctx.clock.t += 3600_000;
    expect(await refreshBlocks(ctx)).toBe(false);
    expect(coreFor(ctx, EAST).id).toBe('core2');
  });

  it('a table older than 10 minutes refreshes itself, behind the answer', async () => {
    const { ctx, core1 } = twoCores();
    await refreshBlocks(ctx);
    const spy = vi.spyOn(core1, 'coreBlocks');
    ctx.clock.t += 9 * 60_000;
    homeCoreOf(ctx, '503');
    expect(spy).not.toHaveBeenCalled();
    ctx.clock.t += 60_001;
    core1.simBlocks([{ index: 2, homeCore: 1, role: 'home', prefix: '8831503' }]);
    expect(homeCoreOf(ctx, '503')).toBe(2); // the answer on hand
    await vi.waitFor(() => expect(homeCoreOf(ctx, '503')).toBe(1));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('both cores down at start: the rule answers, and the table loads without a restart when one returns', async () => {
    const { ctx, core1, core2 } = twoCores();
    rule(ctx);
    core1.simDown('refuse');
    core2.simDown('refuse');
    expect(await refreshBlocks(ctx)).toBe(false);
    expect(blockOf(ctx, '503')).toBeNull();
    expect(coreFor(ctx, WEST).id).toBe('core2');
    core2.simDown(null);
    ctx.clock.t += 60_001;
    expect(coreFor(ctx, WEST).id).toBe('core2');
    await vi.waitFor(() => expect(blockOf(ctx, '503')).toEqual({ homeCore: 2, index: 2 }));
  });

  it('a failing table is not asked on every call: one try a minute', async () => {
    const { ctx, core1, core2 } = twoCores();
    rule(ctx);
    core1.simDown('refuse');
    core2.simDown('refuse');
    const spy = vi.spyOn(core1, 'coreBlocks');
    homeCoreOf(ctx, '503');
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));
    homeCoreOf(ctx, '503');
    homeCoreOf(ctx, '606');
    await new Promise((r) => setTimeout(r, 5));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('housekeeping loads the table at start, before it syncs anything', async () => {
    const { ctx, core1 } = twoCores();
    const stop = startHousekeeping(ctx);
    try {
      await vi.waitFor(() => expect(blockOf(ctx, '503')).toEqual({ homeCore: 2, index: 2 }));
      expect(core1.audit.filter((a) => a.op === 'core.blocks')).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('housekeeping does not ask a lone core for a table nothing needs', async () => {
    const ctx = testCtx();
    const spy = vi.spyOn(ctx.core, 'coreBlocks');
    const stop = startHousekeeping(ctx);
    await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('number operations on two cores (Review Focus)', () => {
  const meta = { ip: '192.0.2.10' };
  function setup() {
    const t = twoCores();
    clearQrFlash();
    forgetGetting();
    applyNanpa(t.ctx, readNanpaDir('tests/fixtures/nanpa'));
    const uid = t.ctx.db.insert(users).values({ name: 'ada', email: 'ada@example.org', emailVerifiedAt: 1, numberLimit: 3, createdAt: 1 }).returning().get().id;
    return { ...t, ada: { id: 'session-ada', userId: uid } };
  }
  const OH = '+883122020701000'; // 220-207 Lancaster, OH: East
  const CA = '+883166120601000'; // 661-206 Lancaster, CA: West
  const FIXTURE: CoreBlock[] = [
    { index: 10, homeCore: 1, role: 'home', prefix: '8831220' },
    { index: 11, homeCore: 2, role: 'secondary', prefix: '8831661' },
  ];

  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    s.core1.simBlocks(FIXTURE);
    s.core2.simBlocks(FIXTURE);
    await refreshBlocks(s.ctx);
  });

  it('get creates a West number on core 2 and not on core 1, and records it', async () => {
    expect(await getNumber(s.ctx, s.ada, { number: CA, listed: 'on' }, meta)).toMatchObject({ ok: true });
    expect(s.core2.numbers()).toEqual([CA]);
    expect(s.core1.numbers()).toEqual([]);
    expect(s.ctx.db.select().from(numbers).get()).toMatchObject({ number: CA, coreId: 'core2' });
  });

  it('core 2 down: West actions say the network did not answer, nothing falls over to core 1; East is untouched', async () => {
    await getNumber(s.ctx, s.ada, { number: CA, listed: 'on' }, meta);
    await getNumber(s.ctx, s.ada, { number: OH, listed: 'on' }, meta);
    s.core2.simDown('refuse');
    const before = s.core1.audit.length;
    expect(await reissueNumber(s.ctx, s.ada, CA, meta)).toMatchObject({ ok: false, error: expect.stringContaining("didn't answer") });
    expect(await releaseNumber(s.ctx, s.ada, CA, meta)).toMatchObject({ ok: false, error: expect.stringContaining("didn't answer") });
    expect(await getNumber(s.ctx, s.ada, { number: '+883166120601001', listed: 'on' }, meta)).toMatchObject({ ok: false, error: expect.stringContaining("didn't answer") });
    expect(s.core1.audit.length).toBe(before);
    const row = s.ctx.db.select().from(numbers).where(eq(numbers.number, CA)).get()!;
    expect(await syncNumber(s.ctx, row)).toMatchObject({ number: CA, state: 'unactivated' });
    expect(await reissueNumber(s.ctx, s.ada, OH, meta)).toMatchObject({ ok: true });
  });

  it('calls ask each number on its home core', async () => {
    await getNumber(s.ctx, s.ada, { number: CA, listed: 'on' }, meta);
    await getNumber(s.ctx, s.ada, { number: OH, listed: 'on' }, meta);
    s.core2.simDown('refuse');
    const r = await accountCalls(s.ctx, s.ada.userId);
    expect(r.unavailable).toEqual([CA]);
    expect(s.core1.audit.filter((a) => a.op === 'cdr.list').map((a) => a.arg)).toEqual([OH]);
  });

  it('places and exchanges take the side from the home in the table', async () => {
    s.core1.simBlocks([{ index: 10, homeCore: 2, role: 'secondary', prefix: '8831220' }]);
    await refreshBlocks(s.ctx);
    expect(exchangeOffered(s.ctx, '+8831220207')).toMatchObject({ side: 'west' });
    expect(searchPlaces(s.ctx, 'lancaster, oh')[0].side).toBe('west');
  });

  it('a wrong-core not_found does not delete a waiting row while the homes are only the rule', async () => {
    // Both cores down at start, so no table. 220 is really homed on core 2 (a --home override), which holds the number.
    const t = setup();
    t.core1.simDown('refuse');
    t.core2.simDown('refuse');
    await refreshBlocks(t.ctx);
    t.core1.simDown(null);
    t.core2.simDown(null);
    const row = t.ctx.db
      .insert(numbers)
      .values({ number: OH, userId: t.ada.userId, coreId: 'core2', listed: false, createdAt: 1, state: 'unactivated', tokenExpiresAt: t.ctx.now() + 3600_000, statusAt: 1 })
      .returning()
      .get();
    expect(await syncNumber(t.ctx, row)).toMatchObject({ number: OH });
    expect(t.ctx.db.select().from(numbers).get()).toMatchObject({ number: OH });
    expect(t.core1.audit.filter((a) => a.op === 'sub.status')).toHaveLength(1); // the rule did send it to core 1
  });
});

describe("the NOC's number operations", () => {
  it('look up and change a number on its home core', async () => {
    const { ctx, core1, core2 } = twoCores();
    await refreshBlocks(ctx);
    core2.simSubscriber(WEST, 1, null);
    expect(await lookupNumber(ctx, 7, WEST, '192.0.2.1')).toMatchObject({ ok: true, core: 'core2' });
    expect(await changeSubscriber(ctx, 7, WEST, false, 'test', '192.0.2.1')).toMatchObject({ ok: true });
    expect((await core2.subStatus(0, WEST)).disabled).toBe(true);
    expect(core1.audit.some((a) => a.op === 'sub.status' || a.op === 'sub.disable')).toBe(false);
  });
});
