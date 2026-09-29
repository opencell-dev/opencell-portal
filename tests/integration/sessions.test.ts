import { beforeEach, describe, expect, it } from 'vitest';
import { users } from '@/db/schema';
import { createSession, endSession, isFresh, markReauth, sessionFromToken } from '@/lib/sessions';
import { grantRole, rolesOf } from '@/lib/users';
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
});
