import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCore } from '@/core/fake';
import type { CoreHandle } from '@/core/types';
import { users } from '@/db/schema';
import { refreshBlocks } from '@/lib/numbers/blocks';
import { forgetCellNames } from '@/lib/numbers/cells';
import { applyNanpa, readNanpaDir } from '@/lib/numbers/nanpa-refresh';
import { forgetGetting, getNumber } from '@/lib/numbers/ownership';
import { clearQrFlash, takeQr } from '@/lib/numbers/qr-flash';
import { accountStatus } from '@/lib/numbers/status';
import { type TestCtx, testCtx } from '../helpers/ctx';

// GET /api/numbers/status (P2 decision 3): the session's own numbers only,
// after a sync, with the card's words. Review Focus: user B never sees A's.

const state: { ctx?: TestCtx; who: { id: string; userId: number } | null } = { who: null };
vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('@/server/request', () => ({
  currentSession: async () => (state.who ? { user: { id: state.who.userId }, session: { id: state.who.id, userId: state.who.userId } } : null),
}));

const { GET } = await import('@/app/api/numbers/status/route');
const A = '+883171746412345';
const B = '+883171746412346';
let ada: { id: string; userId: number };
let bob: { id: string; userId: number };

function user(name: string) {
  const id = state.ctx!.db.insert(users).values({ name, email: `${name}@example.org`, emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  return { id: `s-${name}`, userId: id };
}

beforeEach(async () => {
  state.ctx = testCtx();
  clearQrFlash();
  forgetCellNames();
  applyNanpa(state.ctx, readNanpaDir('tests/fixtures/nanpa'));
  ada = user('ada');
  bob = user('bob');
  await getNumber(state.ctx, ada, { number: A, listed: 'on' }, { ip: '192.0.2.1' });
  await getNumber(state.ctx, bob, { number: B, listed: 'on' }, { ip: '192.0.2.2' });
});

async function status() {
  const r = await GET();
  return { code: r.status, cache: r.headers.get('cache-control'), body: await r.json() };
}

describe('GET /api/numbers/status', () => {
  it('is 401 signed out', async () => {
    state.who = null;
    expect(await status()).toMatchObject({ code: 401, cache: 'no-store' });
  });

  it("answers the session's own numbers, never another account's", async () => {
    state.who = ada;
    const r = await status();
    expect(r).toMatchObject({ code: 200, cache: 'no-store' });
    expect(r.body.numbers).toEqual([
      expect.objectContaining({ number: A, tone: 'wait', label: "Waiting for activation · 3 d 0 h left", terminal: null }),
    ]);
    expect(JSON.stringify(r.body)).not.toContain(B);
  });

  it('shows the flip to activated and registered on the named cell', async () => {
    const ctx = state.ctx!;
    ctx.core.simActivate(takeQr(ada.id, A, ctx.now())!.qr, 0x76ad0488);
    const cell = ctx.core.simAddCell('Roof', 'part15', 1);
    ctx.core.simRegister(A, cell);
    ctx.clock.t += 6000;
    state.who = ada;
    const r = await status();
    expect(r.body.numbers[0]).toMatchObject({ number: A, label: 'Registered on cell Roof', tone: 'ok', terminal: '76ad' });
  });

  it('a hung core: the answer within 3 s in all, the cards as they were, and it says so', async () => {
    const ctx = state.ctx!;
    ctx.core.simActivate(takeQr(ada.id, A, ctx.now())!.qr, 0x76ad0488);
    ctx.core.simRegister(A, ctx.core.simAddCell('Roof', 'part15', 1));
    ctx.clock.t += 6000;
    state.who = ada;
    await status(); // sees it registered
    ctx.clock.t += 120_000; // the cell names are stale too
    ctx.core.simDown('hang');
    const t0 = Date.now();
    const r = await status();
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(r.body.unavailable).toBe(true);
    expect(r.body.numbers[0]).toMatchObject({ number: A, label: 'Registered on cell Roof' });
  }, 10_000);

  it('an expired number is gone from the answer (the card flips to Released)', async () => {
    state.ctx!.clock.t += 72 * 3600_000;
    state.who = ada;
    expect((await status()).body.numbers).toEqual([]);
  });
});

// A visitor (OCSS spec §5.6): (serving core, cell) name the cell, since cell ids are per core.
describe('which cell a card names', () => {
  const WEST = '+883166120601000';

  function twoCores() {
    const base = state.ctx!;
    const core1 = new FakeCore(base.now, { coreId: 1 });
    const core2 = new FakeCore(base.now, { coreId: 2 });
    const table = [
      { index: 1, homeCore: 1, role: 'home' as const, prefix: '8831717' },
      { index: 2, homeCore: 2, role: 'none' as const, prefix: '8831661' },
    ];
    core1.simBlocks(table);
    core2.simBlocks(table);
    const cores: CoreHandle[] = [
      { id: 'core1', where: 'a', coreNo: 1, core: core1 },
      { id: 'core2', where: 'b', coreNo: 2, core: core2 },
    ];
    return { ctx: { ...base, cores }, core1, core2 };
  }

  async function west(ctx: Parameters<typeof getNumber>[0], core2: FakeCore) {
    forgetGetting();
    const r = await getNumber(ctx, ada, { number: WEST, listed: 'on' }, { ip: '192.0.2.1' });
    if (!r.ok) throw new Error(r.error);
    core2.simActivate(r.token.qr, 0x76ad0488);
  }

  it("a visitor on core 1's cell 3, with a home-core cell 3 of another name, shows core 1's name", async () => {
    const { ctx, core1, core2 } = twoCores();
    await refreshBlocks(ctx);
    await west(ctx, core2);
    for (const n of ['a', 'b', 'Roof on core 1']) core1.simAddCell(n, 'part15', 1);
    for (const n of ['x', 'y', 'Other on core 2']) core2.simAddCell(n, 'part15', 1);
    core2.simRegister(WEST, 3, 1);
    ctx.clock.t += 6000;
    const st = (await accountStatus(ctx, ada.userId)).numbers.find((x) => x.number === WEST);
    expect(st).toMatchObject({ label: 'Registered on cell Roof on core 1', tone: 'ok', registered: true });
  });

  it("a subscriber on its home core's own cell shows that core's name", async () => {
    const { ctx, core1, core2 } = twoCores();
    await refreshBlocks(ctx);
    await west(ctx, core2);
    core1.simAddCell('wrong', 'part15', 1);
    core2.simRegister(WEST, core2.simAddCell('Home roof', 'part15', 1));
    ctx.clock.t += 6000;
    expect((await accountStatus(ctx, ada.userId)).numbers.find((x) => x.number === WEST)?.label).toBe('Registered on cell Home roof');
  });

  it('a serving core with no handle here, or a cell it does not know, is the bare id', async () => {
    const { ctx, core1, core2 } = twoCores();
    await refreshBlocks(ctx);
    await west(ctx, core2);
    core2.simAddCell('Home roof', 'part15', 1);
    core2.simRegister(WEST, 1, 3);
    ctx.clock.t += 6000;
    expect((await accountStatus(ctx, ada.userId)).numbers.find((x) => x.number === WEST)?.label).toBe('Registered on cell 1');
    core2.simRegister(WEST, 9, 1);
    ctx.clock.t += 6000;
    forgetCellNames();
    expect(core1.simCells()).toEqual([]);
    expect((await accountStatus(ctx, ada.userId)).numbers.find((x) => x.number === WEST)?.label).toBe('Registered on cell 9');
  });

  it("a v0.7.0 core doesn't say: the cell is read as the home core's", async () => {
    const { ctx, core2 } = twoCores();
    await refreshBlocks(ctx);
    await west(ctx, core2);
    const cell = core2.simAddCell('Home roof', 'part15', 1);
    core2.simRegister(WEST, cell);
    const real = core2.subStatus.bind(core2);
    core2.subStatus = async (a, n) => ({ ...(await real(a, n)), servingCore: null });
    ctx.clock.t += 6000;
    expect((await accountStatus(ctx, ada.userId)).numbers.find((x) => x.number === WEST)?.label).toBe('Registered on cell Home roof');
  });

  it('the pair is kept with the row, so a card between syncs still names the right cell', async () => {
    const { ctx, core1, core2 } = twoCores();
    await refreshBlocks(ctx);
    await west(ctx, core2);
    for (const n of ['a', 'b', 'Roof on core 1']) core1.simAddCell(n, 'part15', 1);
    core2.simRegister(WEST, 3, 1);
    ctx.clock.t += 6000;
    await accountStatus(ctx, ada.userId);
    const asked = core2.audit.filter((a) => a.op === 'sub.status').length;
    expect((await accountStatus(ctx, ada.userId)).numbers.find((x) => x.number === WEST)?.label).toBe('Registered on cell Roof on core 1');
    expect(core2.audit.filter((a) => a.op === 'sub.status')).toHaveLength(asked);
  });

  it('the home core down: the card keeps its cached state and the serving core still names the cell; the page says so', async () => {
    const { ctx, core1, core2 } = twoCores();
    await refreshBlocks(ctx);
    await west(ctx, core2);
    for (const n of ['a', 'b', 'Roof on core 1']) core1.simAddCell(n, 'part15', 1);
    core2.simRegister(WEST, 3, 1);
    ctx.clock.t += 6000;
    await accountStatus(ctx, ada.userId);
    forgetCellNames();
    core2.simDown('refuse');
    ctx.clock.t += 6000;
    const st = await accountStatus(ctx, ada.userId);
    expect(st.unavailable).toBe(true);
    expect(st.numbers.find((x) => x.number === WEST)?.label).toBe('Registered on cell Roof on core 1');
  });
});
