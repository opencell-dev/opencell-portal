import { and, count, desc, eq, inArray, max } from 'drizzle-orm';
import { AGREEMENT_VERSION } from '@/content/operator-agreement';
import { agreementAcceptances, nodeRequests, userRoles, users } from '@/db/schema';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import type { RequestMeta } from '@/lib/sessions';
import { siteHome } from '@/lib/site';

// The Base Station Operator Agreement's log (portal spec §6.1, §6.4). The text
// lives in code (src/content/operator-agreement.ts); a new version asks existing
// operators to re-accept at their next sign-in, and their nodes keep running.

/** Record that the account accepted the current version (again is fine: one row per version). */
export function acceptAgreement(ctx: Ctx, userId: number, version: number, meta: RequestMeta): void {
  if (version !== AGREEMENT_VERSION) throw new Error(`agreement version ${version} is not the current one`);
  const added = ctx.db.insert(agreementAcceptances).values({ userId, version, acceptedAt: ctx.now(), ip: meta.ip }).onConflictDoNothing().run();
  if (added.changes > 0) writeAudit(ctx, { actorId: userId, action: 'agreement.accept', target: `user:${userId}`, detail: { version }, ip: meta.ip });
}

/** The newest version this account accepted, or null. */
export function acceptedVersion(ctx: Ctx, userId: number): number | null {
  return ctx.db.select({ v: max(agreementAcceptances.version) }).from(agreementAcceptances).where(eq(agreementAcceptances.userId, userId)).get()?.v ?? null;
}

function isOperator(ctx: Ctx, userId: number): boolean {
  return ctx.db.select({ r: userRoles.role }).from(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.role, 'operator'))).get() !== undefined;
}

function hasOpenRequest(ctx: Ctx, userId: number): boolean {
  return (
    ctx.db
      .select({ id: nodeRequests.id })
      .from(nodeRequests)
      .where(and(eq(nodeRequests.userId, userId), inArray(nodeRequests.status, ['pending', 'question'])))
      .limit(1)
      .get() !== undefined
  );
}

/** An operator, or someone with an open request, who has not accepted the current version. Only the portal has nodes. */
export function needsAgreement(ctx: Ctx, userId: number): boolean {
  if (ctx.config.site !== 'portal') return false;
  if ((acceptedVersion(ctx, userId) ?? 0) >= AGREEMENT_VERSION) return false;
  return isOperator(ctx, userId) || hasOpenRequest(ctx, userId);
}

export function agreementStats(ctx: Ctx): { version: number; accepted: number }[] {
  return ctx.db
    .select({ version: agreementAcceptances.version, accepted: count() })
    .from(agreementAcceptances)
    .groupBy(agreementAcceptances.version)
    .orderBy(desc(agreementAcceptances.version))
    .all();
}

/** Operators still on an older version (or none), for /admin/agreement. */
export function operatorsBehind(ctx: Ctx): { userId: number; name: string; email: string; version: number | null }[] {
  const operators = ctx.db
    .select({ userId: users.id, name: users.name, email: users.email })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(eq(userRoles.role, 'operator'))
    .all();
  return operators.map((o) => ({ ...o, version: acceptedVersion(ctx, o.userId) })).filter((o) => (o.version ?? 0) < AGREEMENT_VERSION);
}

/** A path on this site, or null: nothing that a browser could read as another origin. */
export function samePath(next: string): string | null {
  if (!next.startsWith('/') || next.startsWith('//') || next.length > 512) return null;
  return /[\\\p{Cc}]/u.test(next) ? null : next;
}

/** Where a sign-in lands: the agreement first when it is due (spec §6.4), then `next`. */
export function postSignInPath(ctx: Ctx, userId: number, next: string): string {
  const to = samePath(next) ?? siteHome(ctx.config.site);
  return needsAgreement(ctx, userId) ? `/nodes/agreement?next=${encodeURIComponent(to)}` : to;
}
