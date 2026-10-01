import { beforeEach, describe, expect, it, vi } from 'vitest';
import { users } from '@/db/schema';
import { listAudit } from '@/lib/audit';
import { rolesOf } from '@/lib/users';
import { type TestCtx, testCtx } from '../helpers/ctx';

// NOC design §4: an admin grants and takes away the NOC operator role from
// /admin/users, with a fresh passkey, as for promoting an admin.

const state: { ctx?: TestCtx; fresh: boolean; adminId: number } = { fresh: true, adminId: 0 };

vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/server/request', () => ({
  freshAdmin: async () => (state.fresh ? { ok: true, s: { user: { id: state.adminId } } } : { ok: false, reauth: true }),
}));

const { nocRoleAction } = await import('@/app/actions/admin');

let ctx: TestCtx;
let nia: number;

beforeEach(() => {
  ctx = testCtx();
  state.ctx = ctx;
  state.fresh = true;
  state.adminId = ctx.db.insert(users).values({ name: 'Root', email: 'root@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  nia = ctx.db.insert(users).values({ name: 'Nia', email: 'nia@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
});

describe('nocRoleAction', () => {
  it('grants the role, audited with the admin as actor, then takes it away', async () => {
    expect(await nocRoleAction('nia@example.org', true)).toEqual({ ok: true, message: 'nia@example.org is now a NOC operator.' });
    expect(rolesOf(ctx, nia)).toEqual(['subscriber', 'noc']);
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: state.adminId, action: 'role.grant', target: `user:${nia}` });
    expect(await nocRoleAction('nia@example.org', true)).toEqual({ ok: true, message: 'nia@example.org is already a NOC operator.' });
    expect(await nocRoleAction('nia@example.org', false)).toEqual({ ok: true, message: 'nia@example.org is no longer a NOC operator.' });
    expect(rolesOf(ctx, nia)).toEqual(['subscriber']);
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: state.adminId, action: 'role.revoke' });
    expect(await nocRoleAction('nia@example.org', false)).toEqual({ ok: true, message: 'nia@example.org is not a NOC operator.' });
  });

  it('asks for a fresh passkey first, and changes nothing until then', async () => {
    state.fresh = false;
    expect(await nocRoleAction('nia@example.org', true)).toEqual({ ok: false, reauth: true });
    expect(rolesOf(ctx, nia)).toEqual(['subscriber']);
  });

  it('refuses a bad address, an unknown one and an unverified one alike', async () => {
    ctx.db.insert(users).values({ name: 'Nov', email: 'new@example.org', createdAt: 2 }).run();
    expect(await nocRoleAction('not an email', true)).toEqual({ ok: false, message: 'Please enter a valid email address.' });
    expect(await nocRoleAction('nobody@example.org', true)).toEqual({ ok: false, message: 'No verified account has that address.' });
    expect(await nocRoleAction('new@example.org', true)).toEqual({ ok: false, message: 'No verified account has that address.' });
  });
});
