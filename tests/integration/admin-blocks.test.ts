import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCore } from '@/core/fake';
import { audit, npas, settings, users } from '@/db/schema';
import { coreBlocksAll, npaTable, overrideCommand, refreshLog, wantedHomes } from '@/lib/admin/blocks';
import { refreshBlocks } from '@/lib/numbers/blocks';
import { coreFor } from '@/lib/numbers/route';
import { testCtx, type TestCtx } from '../helpers/ctx';

const state: { ctx?: TestCtx; fresh: boolean } = { fresh: true };
vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/server/request', () => ({
  freshAdmin: async () => (state.fresh ? { ok: true, s: { user: { id: 42 } } } : { ok: false, reauth: true }),
  requestMeta: async () => ({ ip: '203.0.113.9' }),
}));
const { npaOverrideAction } = await import('@/app/actions/admin-blocks');

function twoCores(): TestCtx {
  const c = testCtx();
  const west = new FakeCore(c.now, { coreId: 2, blocks: [] });
  c.cores.push({ id: 'core2', where: 'x', coreNo: 2, core: west });
  c.db.insert(npas).values([
    { npa: '717', region: 'PA', stateCode: 'US-PA', geographic: true, inService: true, updatedAt: 1 },
    { npa: '503', region: 'OR', stateCode: 'US-OR', geographic: true, inService: true, updatedAt: 1 },
    { npa: '800', region: '', stateCode: null, geographic: false, inService: true, updatedAt: 1 },
  ]).run();
  c.core.simBlocks([
    { index: 1, homeCore: 1, role: 'home', prefix: '8831717' },
    { index: 2, homeCore: 2, role: 'secondary', prefix: '8831503' },
  ], { signed: true, rootVersion: 4, seq: 2, maxIdx: 7, delegateNotAfter: null });
  return c;
}

let ctx: TestCtx;
beforeEach(async () => {
  ctx = twoCores();
  state.ctx = ctx;
  state.fresh = true;
  await refreshBlocks(ctx);
});

describe('npaTable', () => {
  it('shows the home from the block table, the state rule’s side beside it, and the wish', () => {
    const t = npaTable(ctx);
    expect(t.find((r) => r.npa === '717')).toMatchObject({ region: 'PA', stateCode: 'US-PA', home: 1, ruleSide: 'east', geographic: true, inService: true, overrideWanted: null, overrideDone: false });
    expect(t.find((r) => r.npa === '503')).toMatchObject({ home: 2, ruleSide: 'west' });
    expect(t.find((r) => r.npa === '800')).toMatchObject({ home: null, ruleSide: null, geographic: false });
  });

  it('searches by NPA or region', () => {
    expect(npaTable(ctx, '71').map((r) => r.npa)).toEqual(['717']);
    expect(npaTable(ctx, 'or').map((r) => r.npa)).toEqual(['503']);
    expect(npaTable(ctx, '%').map((r) => r.npa)).toEqual([]);
  });
});

describe('the NPA home override', () => {
  it('needs a fresh passkey', async () => {
    state.fresh = false;
    expect(await npaOverrideAction('717', 2)).toEqual({ ok: false, reauth: true });
    expect(ctx.db.select().from(settings).where(eq(settings.key, 'npa_home_wanted:717')).get()).toBeUndefined();
  });

  it('records the wish, audited, and leaves routing alone', async () => {
    const before = coreFor(ctx, '+883171746412345').id;
    expect(await npaOverrideAction('717', 2)).toMatchObject({ ok: true });
    expect(ctx.db.select().from(settings).where(eq(settings.key, 'npa_home_wanted:717')).get()?.value).toBe('2');
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'npa.home_override')).all()).toEqual([expect.objectContaining({ actorId: 42, target: 'npa:717' })]);
    expect(coreFor(ctx, '+883171746412345').id).toBe(before);
    expect(npaTable(ctx, '717')[0]).toMatchObject({ overrideWanted: 2, overrideDone: false, home: 1 });
  });

  it('shows done once core.blocks moves the block', async () => {
    await npaOverrideAction('717', 2);
    ctx.core.simBlocks([
      { index: 1, homeCore: 2, role: 'secondary', prefix: '8831717' },
      { index: 2, homeCore: 2, role: 'secondary', prefix: '8831503' },
    ]);
    await refreshBlocks(ctx);
    expect(npaTable(ctx, '717')[0]).toMatchObject({ overrideWanted: 2, overrideDone: true, home: 2 });
  });

  it('can be cleared', async () => {
    await npaOverrideAction('717', 2);
    expect(await npaOverrideAction('717', null)).toMatchObject({ ok: true });
    expect(npaTable(ctx, '717')[0].overrideWanted).toBeNull();
  });

  it.each([
    ['999', 2],
    ['71', 2],
    ['717', 3],
    ['717', 0],
    ['717; rm', 2],
    ['800', 2],
  ] as [string, number][])('refuses %s to core %d', async (npa, core) => {
    expect(await npaOverrideAction(npa, core)).toMatchObject({ ok: false });
  });

  it('refuses on the NOC site', async () => {
    state.ctx = testCtx({ OC_SITE: 'noc' });
    expect(await npaOverrideAction('717', 2)).toMatchObject({ ok: false });
  });
});

describe('the printed command', () => {
  it('is the laptop’s oc-route make, with the next version and the floor from route.status', async () => {
    await npaOverrideAction('717', 2);
    await npaOverrideAction('503', 1);
    const cmd = await overrideCommand(ctx, 42, wantedHomes(ctx));
    expect(cmd).toBe('oc-route make ~/.config/opencell/secrets/route-root.key route-v5.tbl --version 5 --prev route-v4.tbl --floor 7 --npa npa.csv --core 1=oc-core-1 --core 2=oc-core-2 --east 1 --west 2 --home 503=1 --home 717=2');
  });

  it('has no version it cannot know', async () => {
    await npaOverrideAction('717', 2);
    ctx.core.simDown('refuse');
    const west = ctx.cores[1].core as FakeCore;
    west.simDown('refuse');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = await overrideCommand(ctx, 42, wantedHomes(ctx));
    log.mockRestore();
    expect(cmd).toContain('route-vN.tbl --version N --prev route-vN-1.tbl --floor MAX');
  });

  it('is null with nothing wanted, or everything done', async () => {
    expect(await overrideCommand(ctx, 42, wantedHomes(ctx))).toBeNull();
    await npaOverrideAction('717', 1);
    expect(await overrideCommand(ctx, 42, wantedHomes(ctx))).toBeNull();
  });
});

describe('the rest of the page', () => {
  it('each core’s blocks', async () => {
    const r = await coreBlocksAll(ctx, 42);
    expect(r[0].coreId).toBe('fake');
    expect(r[0].blocks).toHaveLength(2);
    (ctx.cores[1].core as FakeCore).simDown('refuse');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await coreBlocksAll(ctx, 42))[1].blocks).toBe('unreachable');
    log.mockRestore();
  });

  it('the refresh log', () => {
    expect(refreshLog(ctx)).toEqual([]);
  });

  void users;
});
