import { beforeEach, describe, expect, it, vi } from 'vitest';
import { users } from '@/db/schema';
import { forgetCellNames } from '@/lib/numbers/cells';
import { applyNanpa, readNanpaDir } from '@/lib/numbers/nanpa-refresh';
import { getNumber } from '@/lib/numbers/ownership';
import { clearQrFlash, takeQr } from '@/lib/numbers/qr-flash';
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
