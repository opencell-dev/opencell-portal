import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreError } from '@/core/types';
import { numbers, users } from '@/db/schema';
import { listAudit } from '@/lib/audit';
import { checkFree, drawFree } from '@/lib/numbers/browse';
import { applyNanpa, readNanpaDir } from '@/lib/numbers/nanpa-refresh';
import { capsOf, forgetGetting, getNumber, listNumbers, numberOf, releaseNumber, reissueNumber, syncAccount, syncDue, syncNumber, syncWaiting } from '@/lib/numbers/ownership';
import { clearQrFlash, takeQr } from '@/lib/numbers/qr-flash';
import { ownedNumbers } from '@/lib/owned-numbers';
import { setLimit } from '@/lib/ratelimit';
import { type TestCtx, testCtx } from '../helpers/ctx';

const meta = { ip: '192.0.2.10' };
const N = '+883171746412345';
const n = (i: number) => `+8831717464${String(20000 + i)}`;
let ctx: TestCtx;
let ada: { id: string; userId: number };
let bob: { id: string; userId: number };

function user(name: string, limit = 3) {
  const id = ctx.db
    .insert(users)
    .values({ name, email: `${name}@example.org`, emailVerifiedAt: 1, numberLimit: limit, createdAt: 1 })
    .returning()
    .get().id;
  return { id: `session-${name}`, userId: id };
}

beforeEach(() => {
  ctx = testCtx();
  clearQrFlash();
  forgetGetting();
  applyNanpa(ctx, readNanpaDir('tests/fixtures/nanpa'));
  ada = user('ada');
  bob = user('bob');
});

const get = (s = ada, number: unknown = N, listed: unknown = 'on') => getNumber(ctx, s, { number, listed }, meta);

describe('getNumber (spec §4.1 step 3–4, §4.2)', () => {
  it('stores the number after the core issued it, flashes the QR to this session, audits', async () => {
    const r = await get();
    expect(r).toMatchObject({ ok: true, token: { number: N } });
    expect(listNumbers(ctx, ada.userId)).toEqual([
      expect.objectContaining({ number: N, userId: ada.userId, coreId: 'fake', listed: true, state: 'unactivated', tokenExpiresAt: ctx.now() + 72 * 3600_000 }),
    ]);
    expect(takeQr(ada.id, N, ctx.now())?.qr).toMatch(/^opencell:2:/);
    expect(takeQr(bob.id, N, ctx.now())).toBeNull();
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: ada.userId, action: 'number.get', target: `number:${N}` });
    expect(ctx.core.audit.at(-1)).toMatchObject({ actor: ada.userId, op: 'sub.create' });
    // Never the QR or the token in the database.
    expect(JSON.stringify(ctx.db.$client.prepare('SELECT * FROM numbers').all())).not.toContain('opencell:2:');
  });

  it('takes the number as people type it, and an unticked directory box', async () => {
    expect(await get(ada, '(717) 464-12345', null)).toMatchObject({ ok: true }); // FormData.get of an unticked box
    expect(listNumbers(ctx, ada.userId)[0].listed).toBe(false);
  });

  it('refuses what is not a real, offered, assignable number, before asking the core', async () => {
    const calls = ctx.core.audit.length;
    expect(await get(ada, '+883171746400999')).toMatchObject({ ok: false, error: expect.stringMatching(/01000 to 99998/) });
    expect(await get(ada, '+883171749912345')).toMatchObject({ ok: false, error: expect.stringMatching(/not a real exchange/) });
    expect(await get(ada, 'nonsense')).toMatchObject({ ok: false });
    expect(await get(ada, 42)).toMatchObject({ ok: false });
    ctx.db.$client.prepare("UPDATE exchanges SET withdrawn_at = 1 WHERE npa_nxx = '717464'").run();
    expect(await get()).toMatchObject({ ok: false, error: expect.stringMatching(/no longer offered/) });
    expect(ctx.core.audit.length).toBe(calls);
  });

  it('caps: 3 unactivated at once; the account limit in all', async () => {
    const big = user('big', 5);
    for (let i = 0; i < 3; i++) expect(await get(big, n(i))).toMatchObject({ ok: true });
    expect(capsOf(ctx, big.userId)).toEqual({ held: 3, unactivated: 3, limit: 5, canGet: false, why: 'unactivated' });
    expect(await get(big, n(3))).toMatchObject({ ok: false, error: expect.stringMatching(/Activate or release/) });

    for (let i = 0; i < 3; i++) expect(await get(ada, n(10 + i))).toMatchObject({ ok: true });
    for (const row of listNumbers(ctx, ada.userId)) ctx.core.simActivate(takeQr(ada.id, row.number, ctx.now())!.qr, 1);
    await syncDue(ctx, ada.userId, 0);
    expect(capsOf(ctx, ada.userId)).toEqual({ held: 3, unactivated: 0, limit: 3, canGet: false, why: 'limit' });
    expect(await get(ada, n(13))).toMatchObject({ ok: false, error: expect.stringMatching(/limit/) });
  });

  it('at most 10 a day per account', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await get(ada, n(i))).toMatchObject({ ok: true });
      expect(await releaseNumber(ctx, ada, n(i), meta)).toEqual({ ok: true });
    }
    expect(await get(ada, n(10))).toMatchObject({ ok: false, error: expect.stringMatching(/too often today/) });
  });

  it('a double submit or a second tab: one sub.create, one row, and "You already have this number."', async () => {
    const [a, b] = await Promise.all([get(), get()]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((a.ok ? b : a) as { error: string }).toMatchObject({ error: 'You already have this number.' });
    expect(ctx.core.audit.filter((e) => e.op === 'sub.create')).toHaveLength(1);
    expect(listNumbers(ctx, ada.userId)).toHaveLength(1);
    expect(await get()).toMatchObject({ ok: false, error: 'You already have this number.' });
    expect(await get(bob)).toMatchObject({ ok: false, error: expect.stringMatching(/Someone just took that number/) });
  });

  it('a number taken at the core (by someone outside this portal) is "Someone just took that number."', async () => {
    await ctx.core.subCreate(0, N);
    expect(await get()).toMatchObject({ ok: false, error: 'Someone just took that number. Pick another.' });
    expect(listNumbers(ctx, ada.userId)).toEqual([]);
  });

  it('an exchange the core does not route yet (P2 decision 8)', async () => {
    const real = ctx.core.subCreate.bind(ctx.core);
    ctx.core.subCreate = async () => {
      const { CoreError } = await import('@/core/types');
      throw new CoreError('not_assignable', 'no block');
    };
    expect(await get()).toMatchObject({ ok: false, error: "Numbers in this area code aren't open yet." });
    ctx.core.subCreate = real;
    expect(listNumbers(ctx, ada.userId)).toEqual([]);
  });

  it('the core refusing or hanging: a plain message within 3 s, and no row', async () => {
    ctx.core.simDown('refuse');
    expect(await get()).toMatchObject({ ok: false, error: "The network didn't answer. Please try again in a minute." });
    ctx.core.simDown('hang');
    const t0 = Date.now();
    expect(await get()).toMatchObject({ ok: false, error: "The network didn't answer. Please try again in a minute." });
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(listNumbers(ctx, ada.userId)).toEqual([]);
  }, 10_000);
});

describe('expiry, sync, re-issue, release', () => {
  it('after 72 h the core releases it; a sync removes the row (audited) and frees the cap', async () => {
    for (let i = 0; i < 3; i++) await get(ada, n(i));
    expect(capsOf(ctx, ada.userId).canGet).toBe(false);
    ctx.clock.t += 72 * 3600_000;
    expect(await syncDue(ctx, ada.userId)).toEqual([]);
    expect(capsOf(ctx, ada.userId)).toMatchObject({ held: 0, canGet: true });
    expect(listAudit(ctx, 5).filter((a) => a.action === 'number.expired')).toHaveLength(3);
  });

  it('housekeeping syncs the numbers whose token has run out, for every account', async () => {
    await get(ada, n(0));
    await get(bob, n(1));
    ctx.clock.t += 72 * 3600_000 + 1;
    await syncWaiting(ctx, 0);
    expect(ctx.db.select().from(numbers).all()).toEqual([]);
  });

  it('sync maps the status: activated (once), registered, the terminal', async () => {
    const r = await get();
    if (!r.ok) throw new Error(r.error);
    ctx.core.simActivate(r.token.qr, 0x76ad0488);
    const cell = ctx.core.simAddCell('Roof', 'part15', 1);
    ctx.core.simRegister(N, cell);
    const row = await syncNumber(ctx, listNumbers(ctx, ada.userId)[0]);
    expect(row).toMatchObject({ state: 'activated', activatedAt: ctx.now(), registered: true, cellId: cell, tmidPrefix: '76ad', tokenExpiresAt: null, statusAt: ctx.now() });
    ctx.clock.t += 60_000;
    expect((await syncNumber(ctx, row!))?.activatedAt).toBe(ctx.now() - 60_000);
  });

  it('syncDue asks the core at most once per 5 s per number, and leaves the row when the core is down', async () => {
    await get();
    const asks = () => ctx.core.audit.filter((e) => e.op === 'sub.status').length;
    await syncDue(ctx, ada.userId);
    const after = asks();
    await syncDue(ctx, ada.userId);
    expect(asks()).toBe(after);
    ctx.clock.t += 5001;
    ctx.core.simDown('refuse');
    expect(await syncDue(ctx, ada.userId)).toHaveLength(1);
  });

  it('re-issue: owner only, a new QR in the flash, the expiry moves; the old token stops working', async () => {
    const first = await get();
    if (!first.ok) throw new Error(first.error);
    ctx.clock.t += 3600_000;
    expect(await reissueNumber(ctx, bob, N, meta)).toMatchObject({ ok: false });
    const r = await reissueNumber(ctx, ada, N, meta);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error(r.error);
    expect(takeQr(ada.id, N, ctx.now())?.qr).toBe(r.token.qr);
    expect(listNumbers(ctx, ada.userId)[0].tokenExpiresAt).toBe(ctx.now() + 72 * 3600_000);
    expect(() => ctx.core.simActivate(first.token.qr, 1)).toThrow();
    expect(listAudit(ctx, 1)[0]).toMatchObject({ action: 'number.reissue', actorId: ada.userId });
  });

  it('release: owner only, unactivated only', async () => {
    const r = await get();
    if (!r.ok) throw new Error(r.error);
    expect(await releaseNumber(ctx, bob, N, meta)).toMatchObject({ ok: false });
    ctx.core.simActivate(r.token.qr, 1);
    await syncDue(ctx, ada.userId, 0);
    expect(await releaseNumber(ctx, ada, N, meta)).toEqual({ ok: false, error: "This number is active on a terminal; it can't be released here." });
    expect(listNumbers(ctx, ada.userId)).toHaveLength(1);
  });

  it('release frees the number at the core and drops the row and the QR', async () => {
    await get();
    expect(await releaseNumber(ctx, ada, N, meta)).toEqual({ ok: true });
    expect(await ctx.core.numCheck(0, N)).toBe('free');
    expect(listNumbers(ctx, ada.userId)).toEqual([]);
    expect(takeQr(ada.id, N, ctx.now())).toBeNull();
  });

  it('a release activated at the core since the last sync is refused there, and the card catches up', async () => {
    const r = await get();
    if (!r.ok) throw new Error(r.error);
    ctx.core.simActivate(r.token.qr, 1);
    expect(await releaseNumber(ctx, ada, N, meta)).toEqual({ ok: false, error: "This number is active on a terminal; it can't be released here." });
    expect(numberOf(ctx, ada.userId, N)?.state).toBe('activated');
  });

  it('ownedNumbers reads the table', async () => {
    const r = await get();
    if (!r.ok) throw new Error(r.error);
    expect(ownedNumbers(ctx, ada.userId)).toEqual([{ number: N, activated: false }]);
    ctx.core.simActivate(r.token.qr, 1);
    await syncDue(ctx, ada.userId, 0);
    expect(ownedNumbers(ctx, ada.userId)).toEqual([{ number: N, activated: true }]);
    expect(ownedNumbers(ctx, bob.userId)).toEqual([]);
  });

  it('a deleted account takes its rows with it', async () => {
    await get();
    ctx.db.delete(users).where(eq(users.id, ada.userId)).run();
    expect(ctx.db.select().from(numbers).all()).toEqual([]);
  });
});

describe('after the whole-branch review', () => {
  it('a slow core: the number stays in flight until the core answers, so a retry makes no second sub.create and the cap holds', async () => {
    vi.useFakeTimers();
    try {
      const real = ctx.core.subCreate.bind(ctx.core);
      ctx.core.subCreate = async (a, num) => {
        await new Promise((r) => setTimeout(r, 3500));
        return real(a, num);
      };
      const first = get();
      await vi.advanceTimersByTimeAsync(3000);
      expect(await first).toMatchObject({ ok: false, error: "The network didn't answer. Please try again in a minute." });
      expect(listNumbers(ctx, ada.userId)).toEqual([]); // nothing half-written
      expect(capsOf(ctx, ada.userId)).toMatchObject({ held: 1, unactivated: 1 }); // still counted
      expect(await get()).toMatchObject({ ok: false, error: 'You already have this number.' });
      await vi.advanceTimersByTimeAsync(600);
      // It arrived after all: the row, the QR and the audit say so.
      expect(listNumbers(ctx, ada.userId)).toHaveLength(1);
      expect(takeQr(ada.id, N, ctx.now())).not.toBeNull();
      expect(listAudit(ctx, 1)[0]).toMatchObject({ action: 'number.get', detail: expect.stringContaining('"late":true') });
      expect(capsOf(ctx, ada.userId)).toMatchObject({ held: 1, unactivated: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a number whose token ran out is free for the caps and for others, with no sweep having run', async () => {
    for (let i = 0; i < 3; i++) await get(ada, n(i));
    ctx.clock.t += 72 * 3600_000;
    expect(capsOf(ctx, ada.userId)).toMatchObject({ held: 0, unactivated: 0, canGet: true });
    // Bob takes one: the stale row goes first, instead of "Someone just took that number".
    expect(await get(bob, n(0))).toMatchObject({ ok: true });
    expect(listNumbers(ctx, bob.userId).map((r) => r.number)).toEqual([n(0)]);
    expect(listNumbers(ctx, ada.userId).map((r) => r.number)).toEqual([n(1), n(2)]);
  });

  it('a stale holder row with the core down: the network message, not "taken"', async () => {
    await get();
    ctx.clock.t += 72 * 3600_000;
    ctx.core.simDown('refuse');
    expect(await get(bob)).toMatchObject({ ok: false, error: "The network didn't answer. Please try again in a minute." });
  });

  it('a get that fails for want of the core does not use up the daily limit', async () => {
    ctx.core.simDown('refuse');
    for (let i = 0; i < 12; i++) await get(ada, n(i));
    ctx.core.simDown(null);
    expect(await get(ada, n(20))).toMatchObject({ ok: true });
  });

  it('asks at most once per 5 s even while sub.status fails, and says the core did not answer', async () => {
    await get();
    ctx.clock.t += 6000;
    ctx.core.simDown('refuse');
    expect(await syncAccount(ctx, ada.userId)).toMatchObject({ unavailable: true });
    expect(await syncAccount(ctx, ada.userId)).toMatchObject({ unavailable: false }); // not asked again
    ctx.core.simDown(null);
    ctx.clock.t += 6000;
    expect(await syncAccount(ctx, ada.userId)).toMatchObject({ unavailable: false, rows: [expect.objectContaining({ number: N })] });
  });

  it('a core saying rate_limited is logged, and keeps the row', async () => {
    const r = await get();
    if (!r.ok) throw new Error(r.error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx.core.subStatus = async () => {
      throw new CoreError('rate_limited', 'slow down');
    };
    ctx.clock.t += 6000;
    expect(await syncAccount(ctx, ada.userId)).toMatchObject({ unavailable: true });
    expect(log.mock.calls.flat().join(' ')).toMatch(/sub\.status failed/);
    log.mockRestore();
  });

  it('the sweep syncs every waiting number, so an activation reaches the directory without the owner looking', async () => {
    const r = await get();
    if (!r.ok) throw new Error(r.error);
    await get(bob, n(1));
    ctx.core.simActivate(r.token.qr, 1);
    ctx.clock.t += 72 * 3600_000 + 1; // Bob's has run out; Ada's token is gone with the activation
    expect(await syncWaiting(ctx, 0)).toBe(1);
    expect(numberOf(ctx, ada.userId, N)?.state).toBe('activated');
    expect(ctx.db.select().from(numbers).all()).toHaveLength(1);
  });

  it('the sweep stops at the first failure instead of hammering a limited core', async () => {
    await get(ada, n(0));
    await get(ada, n(1));
    ctx.core.simDown('refuse');
    const before = ctx.core.audit.length;
    expect(await syncWaiting(ctx, 0)).toBe(0);
    expect(ctx.core.audit.length).toBe(before); // gated before the audit, and only one was tried
  });

  it('a new terminal moves activatedAt (a QR from before the move is the one that was used)', async () => {
    const r = await get();
    if (!r.ok) throw new Error(r.error);
    ctx.core.simActivate(r.token.qr, 0x11110000);
    await syncDue(ctx, ada.userId, 0);
    const t1 = numberOf(ctx, ada.userId, N)!.activatedAt;
    const again = await reissueNumber(ctx, ada, N, meta);
    if (!again.ok) throw new Error(again.error);
    ctx.clock.t += 60_000;
    ctx.core.simActivate(again.token.qr, 0x22220000);
    await syncDue(ctx, ada.userId, 0);
    expect(numberOf(ctx, ada.userId, N)!.activatedAt).toBe(t1! + 60_000);
  });

  it('re-issue is limited per account: the core has one bucket for everyone', async () => {
    await get();
    setLimit(ctx, 'number_reissue', 2);
    expect(await reissueNumber(ctx, ada, N, meta)).toMatchObject({ ok: true });
    expect(await reissueNumber(ctx, ada, N, meta)).toMatchObject({ ok: true });
    expect(await reissueNumber(ctx, ada, N, meta)).toMatchObject({ ok: false, error: expect.stringMatching(/too often/) });
  });
});

describe('the shortlist and the confirm check (browse.ts)', () => {
  it('draws 8; limited per account', async () => {
    setLimit(ctx, 'number_browse', 2);
    expect(await drawFree(ctx, ada.userId, '+8831717464')).toMatchObject({ ok: true, numbers: expect.any(Array) });
    expect(await checkFree(ctx, ada.userId, N)).toEqual({ ok: true, check: 'free' });
    expect(await drawFree(ctx, ada.userId, '+8831717464')).toMatchObject({ ok: false, error: expect.stringMatching(/too many/i) });
    expect(await checkFree(ctx, ada.userId, N)).toMatchObject({ ok: false, error: expect.stringMatching(/too many/i) });
    expect(await drawFree(ctx, bob.userId, '+8831717464')).toMatchObject({ ok: true });
  });

  it('the shortlist has 8 numbers', async () => {
    const r = await drawFree(ctx, ada.userId, '+8831717464');
    if (!r.ok) throw new Error(r.error);
    expect(r.numbers).toHaveLength(8);
  });

  it('says plainly when the core is down or rate-limited', async () => {
    ctx.core.simDown('refuse');
    expect(await drawFree(ctx, ada.userId, '+8831717464')).toMatchObject({ ok: false, error: "The network didn't answer. Please try again in a minute." });
    expect(await checkFree(ctx, ada.userId, N)).toMatchObject({ ok: false, error: "The network didn't answer. Please try again in a minute." });
    ctx.core.simDown(null);
    ctx.core.numFree = async () => {
      throw new CoreError('rate_limited', 'slow down');
    };
    expect(await drawFree(ctx, ada.userId, '+8831717464')).toMatchObject({ ok: false, error: expect.stringMatching(/busy/) });
  });
});
