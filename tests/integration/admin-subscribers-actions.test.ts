import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { numbers, passkeys, userRoles, users } from '@/db/schema';
import { type TestCtx, testCtx } from '../helpers/ctx';

const N1 = '+883171746412345';
const state: { ctx?: TestCtx; admin: boolean; fresh: boolean; adminId: number } = { admin: true, fresh: true, adminId: 0 };
vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/server/request', () => ({
  freshAdmin: async () => {
    if (!state.admin) throw new Error('NEXT_NOT_FOUND');
    return state.fresh ? { ok: true, s: { user: { id: state.adminId } } } : { ok: false, reauth: true };
  },
  requestMeta: async () => ({ ip: '203.0.113.9' }),
}));
const { disableAccountAction, enableAccountAction, numberDisabledAction } = await import('@/app/actions/admin-subscribers');

let ctx: TestCtx;
let alice: number;

beforeEach(() => {
  ctx = testCtx();
  state.ctx = ctx;
  state.admin = true;
  state.fresh = true;
  state.adminId = ctx.db.insert(users).values({ name: 'Root', email: 'root@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  ctx.db.insert(userRoles).values({ userId: state.adminId, role: 'admin', grantedAt: 1 }).run();
  ctx.db.insert(passkeys).values({ id: 'c', userId: state.adminId, publicKey: Buffer.from([1]), counter: 0, createdAt: 1 }).run();
  alice = ctx.db.insert(users).values({ name: 'Alice', email: 'alice@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  ctx.core.simSubscriber(N1, 5, null);
  ctx.db.insert(numbers).values({ number: N1, userId: alice, coreId: 'fake', createdAt: 1, state: 'activated' }).run();
});

describe('the subscriber actions', () => {
  it('are a 404 for a non-admin', async () => {
    state.admin = false;
    await expect(disableAccountAction(alice, 'alice@example.org')).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(enableAccountAction(alice)).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(numberDisabledAction(N1, true)).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('each need a fresh passkey', async () => {
    state.fresh = false;
    expect(await disableAccountAction(alice, 'alice@example.org')).toEqual({ ok: false, reauth: true });
    expect(await enableAccountAction(alice)).toEqual({ ok: false, reauth: true });
    expect(await numberDisabledAction(N1, true)).toEqual({ ok: false, reauth: true });
    expect(ctx.db.select().from(users).where(eq(users.id, alice)).get()?.disabledAt).toBeNull();
    expect((await ctx.core.subStatus(0, N1)).disabled).toBe(false);
  });

  it('disabling wants the account’s email typed', async () => {
    expect(await disableAccountAction(alice, 'wrong@example.org')).toMatchObject({ ok: false, message: expect.stringContaining('email') });
    expect(ctx.db.select().from(users).where(eq(users.id, alice)).get()?.disabledAt).toBeNull();
    expect(await disableAccountAction(alice, ' ALICE@example.org ')).toMatchObject({ ok: true });
    expect(ctx.db.select().from(users).where(eq(users.id, alice)).get()?.disabledAt).not.toBeNull();
    expect(await enableAccountAction(alice)).toMatchObject({ ok: true });
  });

  it('says which numbers did not follow', async () => {
    ctx.core.simDown('refuse');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await disableAccountAction(alice, 'alice@example.org');
    log.mockRestore();
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('717') });
  });

  it('refuse on the NOC site', async () => {
    state.ctx = testCtx({ OC_SITE: 'noc' });
    expect(await numberDisabledAction(N1, true)).toMatchObject({ ok: false });
    expect(await disableAccountAction(alice, 'alice@example.org')).toMatchObject({ ok: false });
    expect(await enableAccountAction(alice)).toMatchObject({ ok: false });
  });
});
