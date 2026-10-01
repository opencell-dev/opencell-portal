import { beforeEach, describe, expect, it } from 'vitest';
import { users } from '@/db/schema';
import { runAdmin } from '@/lib/admin-cli';
import { listAudit } from '@/lib/audit';
import { canUseAdmin, canUseNoc, createSession, sessionFromToken } from '@/lib/sessions';
import { grantRole, isAdmin, isStaff, revokeRole, rolesOf } from '@/lib/users';
import { type TestCtx, testCtx } from '../helpers/ctx';

// NOC design §4: the NOC operator role ('noc'), N1's second role beside admin.
const H = 3600_000;
let ctx: TestCtx;
let uid: number;

beforeEach(() => {
  ctx = testCtx();
  uid = ctx.db.insert(users).values({ name: 'Nia', email: 'nia@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
});

describe('the NOC operator role', () => {
  it('is granted and revoked like any role, audited, and is staff but not admin', () => {
    expect(grantRole(ctx, uid, 'noc', 1)).toBe(true);
    expect(rolesOf(ctx, uid)).toEqual(['subscriber', 'noc']);
    expect(isStaff(ctx, uid)).toBe(true);
    expect(isAdmin(ctx, uid)).toBe(false);
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: 1, action: 'role.grant', target: `user:${uid}`, detail: '{"role":"noc"}' });
    expect(grantRole(ctx, uid, 'noc', 1)).toBe(false);
    expect(revokeRole(ctx, uid, 'noc', 1)).toEqual({ ok: true });
    expect(rolesOf(ctx, uid)).toEqual(['subscriber']);
    expect(isStaff(ctx, uid)).toBe(false);
  });

  it('lists roles in a fixed order: operator, noc, admin', () => {
    grantRole(ctx, uid, 'admin', null);
    grantRole(ctx, uid, 'noc', null);
    grantRole(ctx, uid, 'operator', null);
    expect(rolesOf(ctx, uid)).toEqual(['subscriber', 'operator', 'noc', 'admin']);
  });

  it('gets 12 h sessions, and the grant shortens open ones', () => {
    const before = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' }, { uv: true });
    grantRole(ctx, uid, 'noc', null);
    const after = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' }, { uv: true });
    ctx.clock.t += 12 * H;
    expect(sessionFromToken(ctx, before.token)).toBeNull();
    expect(sessionFromToken(ctx, after.token)).toBeNull();
  });

  it('opens the NOC on a UV passkey session within 12 h, but never the admin pages', () => {
    grantRole(ctx, uid, 'noc', null);
    const pk = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' }, { uv: true });
    const s = sessionFromToken(ctx, pk.token)!.session;
    expect(canUseNoc(ctx, s)).toBe(true);
    expect(canUseAdmin(ctx, s)).toBe(false);
    ctx.clock.t += 12 * H - 1;
    expect(canUseNoc(ctx, sessionFromToken(ctx, pk.token)!.session)).toBe(true);
  });

  it('does not open the NOC on an email-link session, a passkey without UV, or for a subscriber', () => {
    const plain = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' }, { uv: true });
    expect(canUseNoc(ctx, sessionFromToken(ctx, plain.token)!.session)).toBe(false);
    grantRole(ctx, uid, 'noc', null);
    const email = createSession(ctx, uid, 'email', { ip: '192.0.2.1' });
    const noUv = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' }, { uv: false });
    expect(canUseNoc(ctx, sessionFromToken(ctx, email.token)!.session)).toBe(false);
    expect(canUseNoc(ctx, sessionFromToken(ctx, noUv.token)!.session)).toBe(false);
  });

  it('opens the NOC for an admin too', () => {
    grantRole(ctx, uid, 'admin', null);
    const pk = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' }, { uv: true });
    expect(canUseNoc(ctx, sessionFromToken(ctx, pk.token)!.session)).toBe(true);
  });

  it('does not let a session older than 12 h open the NOC merely by the grant', () => {
    const { token } = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' }, { uv: true });
    ctx.clock.t += 20 * H;
    grantRole(ctx, uid, 'noc', null);
    expect(canUseNoc(ctx, sessionFromToken(ctx, token)!.session)).toBe(false);
  });
});

describe('oc-portal-admin noc-grant / noc-revoke', () => {
  it('grants and revokes by email, and says so when there is nothing to do', () => {
    expect(runAdmin(ctx, ['noc-grant', 'NIA@example.org'])).toEqual({ code: 0, out: 'nia@example.org is now a NOC operator' });
    expect(runAdmin(ctx, ['noc-grant', 'nia@example.org'])).toEqual({ code: 0, out: 'nia@example.org is already a NOC operator' });
    expect(runAdmin(ctx, ['users']).out).toContain('subscriber,noc');
    expect(runAdmin(ctx, ['noc-revoke', 'nia@example.org'])).toEqual({ code: 0, out: 'nia@example.org is no longer a NOC operator' });
    expect(runAdmin(ctx, ['noc-revoke', 'nia@example.org'])).toEqual({ code: 1, out: 'nia@example.org is not a NOC operator' });
  });

  it('refuses unknown and unverified accounts, and a missing argument', () => {
    ctx.db.insert(users).values({ name: 'Nov', email: 'new@example.org', createdAt: 2 }).run();
    expect(runAdmin(ctx, ['noc-grant', 'nobody@example.org'])).toEqual({ code: 1, out: 'no account with email nobody@example.org' });
    expect(runAdmin(ctx, ['noc-grant', 'new@example.org']).code).toBe(1);
    expect(runAdmin(ctx, ['noc-grant']).code).toBe(2);
  });
});
