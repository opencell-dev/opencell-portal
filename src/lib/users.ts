import { and, eq, sql } from 'drizzle-orm';
import { sessions, userRoles, users } from '@/db/schema';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';

/** 'noc': a NOC operator (NOC design §4): the network views, read-only in N1. */
export type Role = 'subscriber' | 'operator' | 'noc' | 'admin';
export type GrantedRole = Exclude<Role, 'subscriber'>;
export type User = typeof users.$inferSelect;

export const ADMIN_SESSION_MS = 12 * 3600_000;

export function getUser(ctx: Ctx, id: number): User | undefined {
  return ctx.db.select().from(users).where(eq(users.id, id)).get();
}

export function findUserByEmail(ctx: Ctx, email: string): User | undefined {
  return ctx.db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).get();
}

/** Subscriber once the email is verified, plus the roles granted (spec §2). */
export function rolesOf(ctx: Ctx, userId: number): Role[] {
  const u = getUser(ctx, userId);
  if (!u) return [];
  const granted = ctx.db.select().from(userRoles).where(eq(userRoles.userId, userId)).all().map((r) => r.role);
  const out: Role[] = u.emailVerifiedAt ? ['subscriber'] : [];
  for (const r of ['operator', 'noc', 'admin'] as const) if (granted.includes(r)) out.push(r);
  return out;
}

export function isAdmin(ctx: Ctx, userId: number): boolean {
  return rolesOf(ctx, userId).includes('admin');
}

/**
 * Staff: an admin or a NOC operator (NOC design §4). Staff sessions last
 * 12 h, staff passkeys need user verification, and only staff open the NOC.
 */
export function isStaff(ctx: Ctx, userId: number): boolean {
  const r = rolesOf(ctx, userId);
  return r.includes('admin') || r.includes('noc');
}

/**
 * Grant a role; true when it was added, false when the account already had it
 * (then nothing is audited). Staff sessions (admin, noc) last 12 h, so open sessions are shortened to that.
 */
export function grantRole(ctx: Ctx, userId: number, role: GrantedRole, byId: number | null): boolean {
  const u = getUser(ctx, userId);
  if (!u) throw new Error(`no user ${userId}`);
  if (!u.emailVerifiedAt) throw new Error('only a verified account can get a role');
  const now = ctx.now();
  const added = ctx.db.transaction((tx) => {
    const ins = tx.insert(userRoles).values({ userId, role, grantedAt: now, grantedBy: byId }).onConflictDoNothing().run();
    if (role === 'admin' || role === 'noc') {
      tx.update(sessions)
        .set({ expiresAt: sql`min(${sessions.expiresAt}, ${now + ADMIN_SESSION_MS})` })
        .where(eq(sessions.userId, userId))
        .run();
    }
    return ins.changes > 0;
  });
  if (added) writeAudit(ctx, { actorId: byId, action: 'role.grant', target: `user:${userId}`, detail: { role } });
  return added;
}

export type RoleResult = { ok: true } | { ok: false; error: string };

/** Whether `userId` is the only admin left (used to guard both revoking the role and deleting the account). */
export function isLastAdmin(ctx: Ctx, userId: number): boolean {
  const admins = ctx.db.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.role, 'admin')).all();
  return admins.length <= 1 && admins.some((a) => a.userId === userId);
}

/** Revoke a role. Refuses to leave the portal with no admin at all. */
export function revokeRole(ctx: Ctx, userId: number, role: GrantedRole, byId: number | null): RoleResult {
  if (role === 'admin' && isLastAdmin(ctx, userId)) {
    return { ok: false, error: 'Cannot remove the last admin.' };
  }
  const del = ctx.db.delete(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.role, role))).run();
  if (del.changes > 0) {
    writeAudit(ctx, { actorId: byId, action: 'role.revoke', target: `user:${userId}`, detail: { role } });
  }
  return { ok: true };
}
