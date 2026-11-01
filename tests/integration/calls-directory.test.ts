import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { numbers, users } from '@/db/schema';
import { accountCalls, CALLS_DAYS } from '@/lib/numbers/calls';
import { directory, DIRECTORY_PAGE } from '@/lib/numbers/directory';
import { type TestCtx, testCtx } from '../helpers/ctx';

let ctx: TestCtx;
const A1 = '+883171746412345';
const A2 = '+883171746412346';
const B1 = '+883171746454321';
const PEER = '+883160655500100';

function user(name: string, over: Partial<typeof users.$inferInsert> = {}) {
  return ctx.db
    .insert(users)
    .values({ name, email: `${name.toLowerCase().replace(/\W/g, '')}@example.org`, emailVerifiedAt: 1, createdAt: 1, ...over })
    .returning()
    .get().id;
}
function hold(userId: number, number: string, over: Partial<typeof numbers.$inferInsert> = {}) {
  ctx.db.insert(numbers).values({ number, userId, coreId: 'fake', createdAt: 0, state: 'activated', ...over }).run();
}

let ada: number;
let bob: number;
beforeEach(() => {
  ctx = testCtx();
  ada = user('Ada Lovelace');
  bob = user('Bob');
});

describe('accountCalls (spec §5 Calls: 90 days, from each number’s home core)', () => {
  beforeEach(() => {
    hold(ada, A1);
    hold(ada, A2);
    hold(bob, B1);
    const t = ctx.now();
    ctx.core.simCall({ at: t - 3600_000, number: A1, peer: PEER, direction: 'out', durationS: 75, result: 'answered' });
    ctx.core.simCall({ at: t - 60_000, number: A2, peer: B1, direction: 'out', durationS: 0, result: 'no_answer' });
    ctx.core.simCall({ at: t - 60_000, number: B1, peer: A2, direction: 'in', durationS: 0, result: 'no_answer' });
    ctx.core.simCall({ at: t - 91 * 86400_000, number: A1, peer: PEER, direction: 'in', durationS: 5, result: 'answered' });
    ctx.core.simCall({ at: t - 89 * 86400_000, number: A1, peer: PEER, direction: 'in', durationS: 9, result: 'answered' });
  });

  it("merges the account's numbers, newest first, 90 days back, and never another account's", async () => {
    expect(CALLS_DAYS).toBe(90);
    const r = await accountCalls(ctx, ada);
    expect(r.unavailable).toEqual([]);
    expect(r.calls.map((c) => [c.mine, c.durationS])).toEqual([
      [A2, 0],
      [A1, 75],
      [A1, 9],
    ]);
    expect(r.calls.every((c) => c.number === c.mine)).toBe(true);
    expect((await accountCalls(ctx, bob)).calls.map((c) => c.number)).toEqual([B1]);
  });

  it('filters by one of the account’s numbers; another account’s number gives nothing', async () => {
    expect((await accountCalls(ctx, ada, A1)).calls).toHaveLength(2);
    expect(await accountCalls(ctx, ada, B1)).toEqual({ calls: [], unavailable: [] });
    expect(ctx.core.audit.filter((e) => e.op === 'cdr.list' && e.arg === B1 && e.actor === ada)).toEqual([]);
  });

  it('a number’s calls from before this account held it are not this account’s', async () => {
    ctx.db.update(numbers).set({ createdAt: ctx.now() - 2 * 3600_000 }).where(eq(numbers.number, A1)).run();
    expect((await accountCalls(ctx, ada, A1)).calls.map((c) => c.durationS)).toEqual([75]);
  });

  it('a core that does not answer is named, not a failure', async () => {
    ctx.core.simDown('refuse');
    expect(await accountCalls(ctx, ada)).toEqual({ calls: [], unavailable: [A1, A2] });
  });
});

describe('directory (spec §5: signed-in only, opt-out)', () => {
  it('lists activated, listed numbers of listed accounts; hides the rest', () => {
    hold(ada, A1);
    hold(ada, A2, { listed: false }); // this number unticked
    hold(bob, B1, { state: 'unactivated' }); // waiting: nobody's yet
    const cyd = user('Cyd', { directoryListed: false }); // the account switch off
    hold(cyd, '+883171746411111');
    const dot = user('Dot');
    hold(dot, '+883171746422222', { disabled: true });
    expect(directory(ctx, '', 1)).toEqual({ rows: [{ name: 'Ada Lovelace', number: A1 }], more: false });
  });

  it('searches by name (any case) and by digits', () => {
    hold(ada, A1);
    hold(bob, B1);
    expect(directory(ctx, 'lovelace', 1).rows.map((r) => r.name)).toEqual(['Ada Lovelace']);
    expect(directory(ctx, 'BOB', 1).rows.map((r) => r.number)).toEqual([B1]);
    expect(directory(ctx, '464-543', 1).rows.map((r) => r.number)).toEqual([B1]);
    expect(directory(ctx, '+883 1 717', 1).rows).toHaveLength(2);
    expect(directory(ctx, '%', 1).rows).toEqual([]); // LIKE wildcards are literal
    expect(directory(ctx, 'x'.repeat(65), 1).rows).toEqual([]);
  });

  it('pages by 50', () => {
    for (let i = 0; i < DIRECTORY_PAGE + 3; i++) {
      const u = user(`User ${String(i).padStart(3, '0')}`);
      hold(u, `+8831717464${String(30000 + i)}`);
    }
    expect(directory(ctx, '', 1)).toMatchObject({ more: true });
    expect(directory(ctx, '', 1).rows).toHaveLength(DIRECTORY_PAGE);
    expect(directory(ctx, '', 2)).toMatchObject({ more: false });
    expect(directory(ctx, '', 2).rows).toHaveLength(3);
    expect(directory(ctx, '', 0).rows).toHaveLength(DIRECTORY_PAGE); // a bad page is page 1
  });
});
