import { eq } from 'drizzle-orm';
import { sessions } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';
import { hashToken, newToken } from '@/lib/tokens';
import { ADMIN_SESSION_MS, getUser, isAdmin, isStaff, siteAdmits, type User } from '@/lib/users';

export const SESSION_MS = 30 * 24 * 3600_000;
export const REAUTH_MS = 5 * 60_000;

export type Session = typeof sessions.$inferSelect;
export type SessionMethod = Session['method'];
export interface RequestMeta {
  ip: string;
  userAgent?: string;
}

export interface SessionOpts {
  /** From the assertion's authenticationInfo.userVerified (passkey sign-in only). */
  uv?: boolean;
  /** The passkey that opened this session, so removing it can revoke the session (spec §3). */
  credentialId?: string;
}

/** A new server-side session; the caller puts `token` in the cookie. */
export function createSession(ctx: Ctx, userId: number, method: SessionMethod, meta: RequestMeta, opts: SessionOpts = {}) {
  const token = newToken();
  const now = ctx.now();
  const expiresAt = now + (isStaff(ctx, userId) ? ADMIN_SESSION_MS : SESSION_MS);
  ctx.db
    .insert(sessions)
    .values({
      id: hashToken(token),
      userId,
      method,
      createdAt: now,
      expiresAt,
      uv: opts.uv ?? false,
      credentialId: opts.credentialId ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 200) ?? null,
    })
    .run();
  return { token, expiresAt };
}

/** The live session and its user for a cookie token, or null (expired ones are removed). */
export function sessionFromToken(ctx: Ctx, token: string | undefined): { session: Session; user: User } | null {
  if (!token || token.length > 64) return null;
  const session = ctx.db.select().from(sessions).where(eq(sessions.id, hashToken(token))).get();
  if (!session) return null;
  if (session.expiresAt <= ctx.now()) {
    ctx.db.delete(sessions).where(eq(sessions.id, session.id)).run();
    return null;
  }
  const user = getUser(ctx, session.userId);
  if (!user) return null;
  // The NOC's site (NOC design §N1.5): an account it no longer admits (its
  // staff role was taken away) is signed out here, session by session.
  if (!siteAdmits(ctx, user.id)) {
    ctx.db.delete(sessions).where(eq(sessions.id, session.id)).run();
    return null;
  }
  return { session, user };
}

export function endSession(ctx: Ctx, token: string): void {
  ctx.db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
}

/** Record a fresh passkey assertion on this session (admin re-auth, spec §3). Always UV-verified (finishReauth requires it), so the session becomes UV-consistent too. */
export function markReauth(ctx: Ctx, sessionId: string): void {
  ctx.db.update(sessions).set({ reauthAt: ctx.now(), uv: true }).where(eq(sessions.id, sessionId)).run();
}

export function isFresh(ctx: Ctx, s: Session): boolean {
  return s.method === 'passkey' && s.reauthAt !== null && ctx.now() - s.reauthAt < REAUTH_MS;
}

/**
 * Admin pages need an admin whose session was opened with a UV-verified
 * passkey, no older than the 12h admin window. That bound is enforced here,
 * not just by shortening expiresAt at grant time: a long-lived session that
 * predates the promotion by more than 12h must not become admin-capable just
 * because it's still otherwise valid.
 */
export function canUseAdmin(ctx: Ctx, s: Session): boolean {
  return s.method === 'passkey' && s.uv && isAdmin(ctx, s.userId) && ctx.now() - s.createdAt < ADMIN_SESSION_MS;
}

/**
 * NOC pages (NOC design §4) need staff (an admin or a NOC operator) on a
 * UV-verified passkey session no older than the 12 h staff window: the same
 * bar as canUseAdmin, with the NOC role admitted too.
 */
export function canUseNoc(ctx: Ctx, s: Session): boolean {
  return s.method === 'passkey' && s.uv && isStaff(ctx, s.userId) && ctx.now() - s.createdAt < ADMIN_SESSION_MS;
}
