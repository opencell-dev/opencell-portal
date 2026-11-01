import { beforeAll, describe, expect, it, vi } from 'vitest';
import { applyNanpa, readNanpaDir } from '@/lib/numbers/nanpa-refresh';
import { setLimit } from '@/lib/ratelimit';
import { type TestCtx, testCtx } from '../helpers/ctx';

const state: { ctx?: TestCtx; signedIn: boolean } = { signedIn: false };
vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('@/server/request', () => ({ currentSession: async () => (state.signedIn ? { user: { id: 1 }, session: {} } : null) }));

const { GET } = await import('@/app/api/places/route');

beforeAll(() => {
  state.ctx = testCtx();
  applyNanpa(state.ctx, readNanpaDir('tests/fixtures/nanpa'));
});

const get = (q: string) => GET(new Request(`https://portal.test/api/places?q=${encodeURIComponent(q)}`));

describe('GET /api/places', () => {
  it('is limited per account, with a plain answer', async () => {
    const ctx = testCtx();
    applyNanpa(ctx, readNanpaDir('tests/fixtures/nanpa'));
    const prev = state.ctx;
    state.ctx = ctx;
    state.signedIn = true;
    setLimit(ctx, 'places_account', 1);
    expect((await get('york')).status).toBe(200);
    const r = await get('york');
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ places: [], error: expect.stringMatching(/too many/i) });
    state.ctx = prev;
  });

  it('is for signed-in subscribers only', async () => {
    state.signedIn = false;
    const r = await get('lancaster');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'Please sign in.' });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('answers suggestions, never cached; an overlong query gets none', async () => {
    state.signedIn = true;
    const r = await get('lancaster, pa');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect((await r.json()).places.map((p: { label: string }) => p.label)).toEqual(['Lancaster, PA (717-291, +5 more)']);
    expect(await (await get('l'.repeat(65))).json()).toEqual({ places: [] });
  });
});
