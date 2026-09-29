import { and, eq, sql } from 'drizzle-orm';
import { sessions, userRoles, users } from '@/db/schema';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';

export type Role = 'subscriber' | 'operator' | 'admin';
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
  for (const r of ['operator', 'admin'] as const) if (granted.includes(r)) out.push(r);
  return out;
}

export function isAdmin(ctx: Ctx, userId: number): boolean {
  return rolesOf(ctx, userId).includes('admin');
}

/** Grant a role. Admin sessions last 12 h, so open sessions are shortened to that. */
export function grantRole(ctx: Ctx, userId: number, role: GrantedRole, byId: number | null): void {
  const u = getUser(ctx, userId);
  if (!u) throw new Error(`no user ${userId}`);
  if (!u.emailVerifiedAt) throw new Error('only a verified account can get a role');
  const now = ctx.now();
  ctx.db.transaction((tx) => {
    tx.insert(userRoles).values({ userId, role, grantedAt: now, grantedBy: byId }).onConflictDoNothing().run();
    if (role === 'admin') {
      tx.update(sessions)
        .set({ expiresAt: sql`min(${sessions.expiresAt}, ${now + ADMIN_SESSION_MS})` })
        .where(eq(sessions.userId, userId))
        .run();
    }
  });
  writeAudit(ctx, { actorId: byId, action: 'role.grant', target: `user:${userId}`, detail: { role } });
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
