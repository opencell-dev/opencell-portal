import { beforeEach, describe, expect, it, vi } from 'vitest';
import { passkeys, users } from '@/db/schema';
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

const { nocRoleAction, promoteAction } = await import('@/app/actions/admin');

let ctx: TestCtx;
let nia: number;

/** A passkey row for `userId` (review I3: granting needs one on the account first). */
function addPasskeyRow(userId: number) {
  ctx.db.insert(passkeys).values({ id: `cred-${userId}`, userId, publicKey: Buffer.from([1]), counter: 0, createdAt: 1 }).run();
}

beforeEach(() => {
  ctx = testCtx({ OC_SITE: 'noc' });
  state.ctx = ctx;
  state.fresh = true;
  state.adminId = ctx.db.insert(users).values({ name: 'Root', email: 'root@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  nia = ctx.db.insert(users).values({ name: 'Nia', email: 'nia@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
});

describe('nocRoleAction', () => {
  it('grants the role, audited with the admin as actor, then takes it away', async () => {
    addPasskeyRow(nia);
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

  it('refuses to grant an account with no passkey yet, so the first grant cannot lock it out (review I3)', async () => {
    expect(await nocRoleAction('nia@example.org', true)).toEqual({
      ok: false,
      message: 'nia@example.org has no passkey yet: ask them to add one on Account first.',
    });
    expect(rolesOf(ctx, nia)).toEqual(['subscriber']);
    addPasskeyRow(nia);
    expect(await nocRoleAction('nia@example.org', true)).toEqual({ ok: true, message: 'nia@example.org is now a NOC operator.' });
  });

  it('is refused on the subscriber portal, where the NOC role means nothing (NOC design §N1.5)', async () => {
    addPasskeyRow(nia);
    state.ctx = { ...ctx, config: { ...ctx.config, site: 'portal' } };
    expect(await nocRoleAction('nia@example.org', true)).toEqual({ ok: false, message: 'NOC roles are given on the NOC site.' });
    expect(rolesOf(ctx, nia)).toEqual(['subscriber']);
  });

  it('promoting an admin on the NOC site needs a passkey on the account first, as the role does (review I3)', async () => {
    expect(await promoteAction('nia@example.org')).toEqual({
      ok: false,
      message: 'nia@example.org has no passkey yet: ask them to add one on Account first.',
    });
    expect(rolesOf(ctx, nia)).toEqual(['subscriber']);
    addPasskeyRow(nia);
    expect(await promoteAction('nia@example.org')).toEqual({ ok: true, message: 'nia@example.org is now an admin.' });
  });
});
