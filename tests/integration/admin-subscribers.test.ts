import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, emailTokens, nodeRequests, nodes, numbers, sessions, userRoles, users } from '@/db/schema';
import { consumeEmailToken, deleteAccount, requestMagicLink } from '@/lib/accounts';
import { disableAccount, enableAccount, searchSubscribers, setNumberDisabled, subscriberDetail } from '@/lib/admin/subscribers';
import { directory } from '@/lib/numbers/directory';
import { createSession, sessionFromToken } from '@/lib/sessions';
import { hashToken } from '@/lib/tokens';
import { makeSetupToken, peekToken } from '@/lib/nodes/setup-tokens';
import { ACCOUNT_DISABLED, adminContacts, isLastAdmin, revokeRole } from '@/lib/users';
import { testCtx, type TestCtx } from '../helpers/ctx';

const META = { ip: '203.0.113.9' };
const N1 = '+883171746412345';
const N2 = '+883171746454321';
const N3 = '+883171746412999';

const state: { ctx?: TestCtx; token?: string; fresh: boolean; adminId: number } = { fresh: true, adminId: 0 };
vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === state.ctx!.config.sessionCookie && state.token ? { value: state.token } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const { requireUser } = await import('@/server/request');

let ctx: TestCtx;
let root: number;
let alice: number;

function user(c: TestCtx, name: string, email: string) {
  return c.db.insert(users).values({ name, email, emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
}

function hold(number: string, userId: number, over: Partial<typeof numbers.$inferInsert> = {}) {
  ctx.core.simSubscriber(number, Math.floor(Math.random() * 1e9), null);
  ctx.db.insert(numbers).values({ number, userId, coreId: 'fake', createdAt: 1, state: 'activated', ...over }).run();
}

const row = (number: string) => ctx.db.select().from(numbers).where(eq(numbers.number, number)).get()!;

beforeEach(() => {
  ctx = testCtx();
  state.ctx = ctx;
  state.token = undefined;
  root = user(ctx, 'Root', 'root@example.org');
  ctx.db.insert(userRoles).values({ userId: root, role: 'admin', grantedAt: 1 }).run();
  state.adminId = root;
  alice = user(ctx, 'Alice Liddell', 'alice@example.org');
  hold(N1, alice);
  hold(N2, alice);
});

describe('searching', () => {
  it('by name, email (any case) or digits of a number', () => {
    expect(searchSubscribers(ctx, 'LIDDELL', 1).rows.map((r) => r.id)).toEqual([alice]);
    expect(searchSubscribers(ctx, 'ALICE@EX', 1).rows.map((r) => r.id)).toEqual([alice]);
    expect(searchSubscribers(ctx, '717464 12345', 1).rows.map((r) => r.id)).toEqual([alice]);
    expect(searchSubscribers(ctx, '+883-1-717-464-54321', 1).rows.map((r) => r.id)).toEqual([alice]);
    expect(searchSubscribers(ctx, 'nobody', 1).rows).toEqual([]);
    expect(searchSubscribers(ctx, '%', 1).rows).toEqual([]);
    expect(searchSubscribers(ctx, 'x'.repeat(65), 1).rows).toEqual([]);
  });

  it('lists everyone with no query, and says what they hold', () => {
    const r = searchSubscribers(ctx, '', 1);
    expect(r.rows.map((x) => x.id)).toEqual([root, alice]);
    expect(r.rows[1]).toMatchObject({ name: 'Alice Liddell', email: 'alice@example.org', verified: true, disabled: false, numbers: 2, roles: ['subscriber'] });
    expect(r.rows[0].roles).toContain('admin');
    expect(r.more).toBe(false);
  });

  it('pages by 50', () => {
    for (let i = 0; i < 60; i++) user(ctx, `U${i}`, `u${i}@example.org`);
    const a = searchSubscribers(ctx, '', 1);
    expect(a.rows).toHaveLength(50);
    expect(a.more).toBe(true);
    const b = searchSubscribers(ctx, '', 2);
    expect(b.rows).toHaveLength(12);
    expect(b.more).toBe(false);
    expect(searchSubscribers(ctx, '', -1).rows).toHaveLength(50);
  });

  it('the detail', () => {
    createSession(ctx, alice, 'email', META);
    const d = subscriberDetail(ctx, alice)!;
    expect(d.user.email).toBe('alice@example.org');
    expect(d.numbers.map((n) => n.number).sort()).toEqual([N1, N2].sort());
    expect(d.sessions).toBe(1);
    expect(d.requests).toEqual([]);
    expect(d.nodes).toEqual([]);
    expect(d.agreement).toBeNull();
    expect(subscriberDetail(ctx, 999)).toBeNull();
  });
});

describe('disabling an account', () => {
  it('ends its sessions, disables its numbers at the core, and marks them', async () => {
    const { token } = createSession(ctx, alice, 'email', META);
    const r = await disableAccount(ctx, root, alice, META);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.numbers.sort((a, b) => a.number.localeCompare(b.number))).toEqual([
      { number: N1, ok: true },
      { number: N2, ok: true },
    ]);
    expect(ctx.db.select().from(sessions).where(eq(sessions.userId, alice)).all()).toEqual([]);
    expect(sessionFromToken(ctx, token)).toBeNull();
    expect((await ctx.core.subStatus(0, N1)).disabled).toBe(true);
    expect(row(N1)).toMatchObject({ disabled: true, disabledBy: 'account' });
    expect(ctx.db.select().from(users).where(eq(users.id, alice)).get()).toMatchObject({ disabledAt: ctx.clock.t, disabledBy: root });
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ to: 'alice@example.org', subject: expect.stringContaining('disabled') });
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'account.disable')).all()).toEqual([expect.objectContaining({ actorId: root, target: `user:${alice}` })]);
    expect(ctx.core.audit.filter((a) => a.op === 'sub.disable').every((a) => a.actor === root)).toBe(true);
  });

  it('enabling reverses only what the account’s disabling did', async () => {
    hold(N3, alice);
    expect((await setNumberDisabled(ctx, root, N3, true, META)).ok).toBe(true);
    expect(row(N3)).toMatchObject({ disabled: true, disabledBy: 'admin' });
    expect((await disableAccount(ctx, root, alice, META)).ok).toBe(true);
    expect(row(N3).disabledBy).toBe('admin');
    const r = await enableAccount(ctx, root, alice, META);
    expect(r).toMatchObject({ ok: true });
    expect(row(N1)).toMatchObject({ disabled: false, disabledBy: null });
    expect((await ctx.core.subStatus(0, N1)).disabled).toBe(false);
    expect(row(N3)).toMatchObject({ disabled: true, disabledBy: 'admin' });
    expect((await ctx.core.subStatus(0, N3)).disabled).toBe(true);
    expect(ctx.db.select().from(users).where(eq(users.id, alice)).get()?.disabledAt).toBeNull();
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent.at(-1)?.subject).toContain('enabled');
  });

  it('a core failure gives a partial list, and running it again finishes', async () => {
    const real = ctx.core.subDisable.bind(ctx.core);
    const spy = vi.spyOn(ctx.core, 'subDisable').mockImplementation(async (a, n) => {
      if (n === N2) throw Object.assign(new Error('down'), { code: 'unavailable', [Symbol.for('opencell.CoreError')]: true });
      return real(a, n);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await disableAccount(ctx, root, alice, META);
    log.mockRestore();
    expect(r.ok && Object.fromEntries(r.numbers.map((x) => [x.number, x.ok]))).toEqual({ [N1]: true, [N2]: false });
    expect(row(N1).disabled).toBe(true);
    expect(row(N2).disabled).toBe(false);
    spy.mockRestore();
    await ctx.mailQueue.drain();
    const mails = ctx.mailer.sent.length;
    const again = await disableAccount(ctx, root, alice, META);
    expect(again.ok && again.numbers).toEqual([{ number: N2, ok: true }]);
    expect(row(N2)).toMatchObject({ disabled: true, disabledBy: 'account' });
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent.length).toBe(mails);
  });

  it('refuses self, and the last admin', async () => {
    expect(await disableAccount(ctx, root, root, META)).toMatchObject({ ok: false });
    const other = user(ctx, 'Op', 'op@example.org');
    expect(await disableAccount(ctx, other, root, META)).toMatchObject({ ok: false, error: expect.stringContaining('last admin') });
    expect(ctx.db.select().from(users).where(eq(users.id, root)).get()?.disabledAt).toBeNull();
  });

  it('a second admin can be disabled by the first', async () => {
    const two = user(ctx, 'Two', 'two@example.org');
    ctx.db.insert(userRoles).values({ userId: two, role: 'admin', grantedAt: 1 }).run();
    expect((await disableAccount(ctx, root, two, META)).ok).toBe(true);
  });

  it('refuses an account that does not exist, and the NOC site', async () => {
    expect((await disableAccount(ctx, root, 999, META)).ok).toBe(false);
    const noc = testCtx({ OC_SITE: 'noc' });
    expect((await disableAccount(noc, 1, 2, META)).ok).toBe(false);
  });

  it('takes it off the directory', async () => {
    ctx.db.update(numbers).set({ listed: true }).run();
    expect(directory(ctx, 'alice', 1).rows.length).toBeGreaterThan(0);
    ctx.db.update(users).set({ disabledAt: 1 }).where(eq(users.id, alice)).run();
    expect(directory(ctx, 'alice', 1).rows).toEqual([]);
  });

  it('keeps its email links from opening anything', async () => {
    await disableAccount(ctx, root, alice, META);
    await ctx.mailQueue.drain();
    ctx.mailer.sent.length = 0;
    expect((await requestMagicLink(ctx, { email: 'alice@example.org' }, META)).ok).toBe(true);
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent).toEqual([]);
    ctx.db.insert(emailTokens).values({ id: hashToken('a-link-from-before'), userId: alice, purpose: 'magic', createdAt: ctx.now(), expiresAt: ctx.now() + 1000 }).run();
    expect(await consumeEmailToken(ctx, 'a-link-from-before', META)).toEqual({ ok: false, error: ACCOUNT_DISABLED });
    expect(ctx.db.select().from(sessions).where(eq(sessions.userId, alice)).all()).toEqual([]);
  });
});

describe('a disabled admin', () => {
  it('gets no more mail, and does not count as an admin left', async () => {
    const two = user(ctx, 'Two', 'two@example.org');
    ctx.db.insert(userRoles).values({ userId: two, role: 'admin', grantedAt: 1 }).run();
    expect(isLastAdmin(ctx, root)).toBe(false);
    expect((await disableAccount(ctx, root, two, META)).ok).toBe(true);
    expect(adminContacts(ctx).map((a) => a.id)).toEqual([root]);
    expect(isLastAdmin(ctx, root)).toBe(true);
    expect(revokeRole(ctx, root, 'admin', null)).toMatchObject({ ok: false });
    expect(await deleteAccount(ctx, root, { confirmEmail: 'root@example.org', choices: {} }, META)).toMatchObject({ ok: false });
  });
});

describe('a disabled operator’s setup command', () => {
  it('stops working, and enabling the account does not bring it back', async () => {
    const n = ctx.db.insert(nodes).values({ requestId: 1, userId: alice, coreId: 'fake', cellId: 3, cellName: 'x', certCn: 'x', siteName: 'x', lat: 39, lon: -77, region: 'MD', contactPhone: 'x', anchor: 3, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1 }).returning().get();
    const { token } = makeSetupToken(ctx, n.id, root);
    expect(peekToken(ctx, token).ok).toBe(true);
    await disableAccount(ctx, root, alice, META);
    expect(peekToken(ctx, token).ok).toBe(false);
    await enableAccount(ctx, root, alice, META);
    expect(peekToken(ctx, token).ok).toBe(false);
  });
});

describe('a signed-in account that gets disabled', () => {
  it('goes to the sign-in page with the message at its next request', async () => {
    const { token } = createSession(ctx, alice, 'email', META);
    state.token = token;
    expect((await requireUser()).user.id).toBe(alice);
    await disableAccount(ctx, root, alice, META);
    await expect(requireUser()).rejects.toThrow('NEXT_REDIRECT /sign-in?disabled=1');
  });

  it('an ordinary expired cookie just goes to sign-in', async () => {
    state.token = 'nothing-like-this';
    await expect(requireUser()).rejects.toThrow('NEXT_REDIRECT /sign-in');
    await expect(requireUser()).rejects.not.toThrow('disabled');
  });
});

describe('disabling one number', () => {
  it('goes to the core and marks it the admin’s', async () => {
    expect((await setNumberDisabled(ctx, root, N1, true, META)).ok).toBe(true);
    expect(row(N1)).toMatchObject({ disabled: true, disabledBy: 'admin' });
    expect((await setNumberDisabled(ctx, root, N1, false, META)).ok).toBe(true);
    expect(row(N1)).toMatchObject({ disabled: false, disabledBy: null });
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'number.disable')).all()).toHaveLength(1);
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'number.enable')).all()).toHaveLength(1);
  });

  it('says so when the core does not answer, and changes nothing', async () => {
    ctx.core.simDown('refuse');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await setNumberDisabled(ctx, root, N1, true, META);
    log.mockRestore();
    expect(r.ok).toBe(false);
    expect(row(N1).disabled).toBe(false);
  });

  it('refuses a number no account holds', async () => {
    expect((await setNumberDisabled(ctx, root, N3, true, META)).ok).toBe(false);
  });
});

describe('deleting an account that hosts a node (decision 23)', () => {
  it('leaves the node with no operator, deletes the requests, and tells the admins', async () => {
    const bob = user(ctx, 'Bob', 'bob@example.org');
    ctx.db.insert(nodeRequests).values({ userId: bob, siteName: 'Open', lat: 39, lon: -77, region: 'MD', piModel: 'pi5', w12Boards: 1, gps: false, antenna: 'Whip', backhaul: 'home', power: 'mains', contactPhone: '+13015550100', agreementVersion: 1, agreedAt: 1, status: 'pending', createdAt: 1 }).run();
    const n = ctx.db.insert(nodes).values({ requestId: 1, userId: bob, coreId: 'fake', cellId: 3, cellName: 'roof', certCn: 'x', siteName: 'Bob Roof', lat: 39.5, lon: -77.5, region: 'MD', contactPhone: '+13015550111', anchor: 3, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1 }).returning().get();
    expect(await deleteAccount(ctx, bob, { confirmEmail: 'bob@example.org', choices: {} }, META)).toEqual({ ok: true });
    expect(ctx.db.select().from(nodes).where(eq(nodes.id, n.id)).get()).toMatchObject({ userId: null, contactPhone: '+13015550111', lat: 39.5 });
    expect(ctx.db.select().from(nodeRequests).all()).toEqual([]);
    await ctx.mailQueue.drain();
    const mail = ctx.mailer.sent.find((m) => m.to === 'root@example.org')!;
    expect(mail.subject).toContain(`Node ${n.id} has no operator`);
  });

  it('tells nobody when the account hosts nothing', async () => {
    const bob = user(ctx, 'Bob', 'bob@example.org');
    await deleteAccount(ctx, bob, { confirmEmail: 'bob@example.org', choices: {} }, META);
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent).toEqual([]);
  });
});
