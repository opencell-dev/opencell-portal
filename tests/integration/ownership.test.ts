import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { numbers, users } from '@/db/schema';
import { listAudit } from '@/lib/audit';
import { applyNanpa, readNanpaDir } from '@/lib/numbers/nanpa-refresh';
import { capsOf, getNumber, listNumbers, releaseNumber, reissueNumber, syncDue, syncExpired, syncNumber } from '@/lib/numbers/ownership';
import { clearQrFlash, takeQr } from '@/lib/numbers/qr-flash';
import { ownedNumbers } from '@/lib/owned-numbers';
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
    await syncExpired(ctx);
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
