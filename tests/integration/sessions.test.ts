import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { audit, users } from '@/db/schema';
import { canUseAdmin, createSession, endSession, isFresh, markReauth, sessionFromToken } from '@/lib/sessions';
import { grantRole, revokeRole, rolesOf } from '@/lib/users';
import { type TestCtx, testCtx } from '../helpers/ctx';

const H = 3600_000;
let ctx: TestCtx;
let uid: number;

beforeEach(() => {
  ctx = testCtx();
  uid = ctx.db.insert(users).values({ name: 'A', email: 'a@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
});

describe('sessions (spec §3)', () => {
  it('lasts 30 days for a subscriber', () => {
    const { token } = createSession(ctx, uid, 'email', { ip: '192.0.2.1' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    ctx.clock.t += 30 * 24 * H - 1;
    expect(sessionFromToken(ctx, token)?.user.id).toBe(uid);
    ctx.clock.t += 1;
    expect(sessionFromToken(ctx, token)).toBeNull();
  });

  it('lasts 12 hours for an admin, and promotion shortens open sessions', () => {
    const before = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' });
    grantRole(ctx, uid, 'admin', null);
    expect(rolesOf(ctx, uid)).toEqual(['subscriber', 'admin']);
    const after = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' });
    ctx.clock.t += 12 * H;
    expect(sessionFromToken(ctx, before.token)).toBeNull();
    expect(sessionFromToken(ctx, after.token)).toBeNull();
  });

  it('ends on sign-out', () => {
    const { token } = createSession(ctx, uid, 'email', { ip: '192.0.2.1' });
    endSession(ctx, token);
    expect(sessionFromToken(ctx, token)).toBeNull();
  });

  it('knows a fresh passkey re-authentication (5 minutes)', () => {
    const { token } = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' });
    const s = sessionFromToken(ctx, token)!.session;
    expect(isFresh(ctx, s)).toBe(false);
    markReauth(ctx, s.id);
    expect(isFresh(ctx, sessionFromToken(ctx, token)!.session)).toBe(true);
    ctx.clock.t += 5 * 60_000;
    expect(isFresh(ctx, sessionFromToken(ctx, token)!.session)).toBe(false);
  });

  it('does not find a session by a forged or unknown token', () => {
    createSession(ctx, uid, 'email', { ip: '192.0.2.1' });
    expect(sessionFromToken(ctx, 'x'.repeat(43))).toBeNull();
    expect(sessionFromToken(ctx, '')).toBeNull();
  });

  it('does not let a session already older than 12h become admin-capable merely by promotion', () => {
    const { token } = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' }, { uv: true });
    ctx.clock.t += 20 * H; // older than the admin window before promotion even happens
    grantRole(ctx, uid, 'admin', null); // shortens expiresAt to now+12h, but the session itself is already old
    const s = sessionFromToken(ctx, token)!.session;
    expect(canUseAdmin(ctx, s)).toBe(false);
  });

  it('lets a session created after promotion be admin-capable for up to 12h', () => {
    grantRole(ctx, uid, 'admin', null);
    const { token } = createSession(ctx, uid, 'passkey', { ip: '192.0.2.1' }, { uv: true });
    const s = sessionFromToken(ctx, token)!.session;
    expect(canUseAdmin(ctx, s)).toBe(true);
    ctx.clock.t += 12 * H - 1;
    expect(canUseAdmin(ctx, sessionFromToken(ctx, token)!.session)).toBe(true);
  });
});

describe('roles (spec §2)', () => {
  it('does not audit a revoke that removed nothing', () => {
    const before = ctx.db.select().from(audit).all().length;
    expect(revokeRole(ctx, uid, 'operator', null)).toEqual({ ok: true });
    expect(ctx.db.select().from(audit).all()).toHaveLength(before);
  });

  it('audits a revoke that actually removed a role', () => {
    grantRole(ctx, uid, 'operator', null);
    expect(revokeRole(ctx, uid, 'operator', null)).toEqual({ ok: true });
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'role.revoke')).all()).toHaveLength(1);
    expect(rolesOf(ctx, uid)).not.toContain('operator');
  });

  it('refuses to remove the last admin', () => {
    grantRole(ctx, uid, 'admin', null);
    expect(revokeRole(ctx, uid, 'admin', null)).toEqual({ ok: false, error: 'Cannot remove the last admin.' });
    expect(rolesOf(ctx, uid)).toContain('admin');
  });

  it('allows removing an admin once another one remains', () => {
    const other = ctx.db.insert(users).values({ name: 'B', email: 'b@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
    grantRole(ctx, uid, 'admin', null);
    grantRole(ctx, other, 'admin', null);
    expect(revokeRole(ctx, uid, 'admin', null)).toEqual({ ok: true });
    expect(rolesOf(ctx, uid)).not.toContain('admin');
    expect(rolesOf(ctx, other)).toContain('admin');
  });
});
