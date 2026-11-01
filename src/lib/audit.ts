import { and, asc, desc, gte, lte } from 'drizzle-orm';
import { audit } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';

export interface AuditInput {
  actorId: number | null;
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

/** Record a portal action. `actorId` is the account acting, null for the system. */
export function writeAudit(ctx: Ctx, a: AuditInput): void {
  ctx.db
    .insert(audit)
    .values({
      at: ctx.now(),
      actorId: a.actorId,
      action: a.action,
      target: a.target ?? null,
      detail: a.detail ? JSON.stringify(a.detail) : null,
      ip: a.ip ?? null,
    })
    .run();
}

export function listAudit(ctx: Ctx, limit: number) {
  return ctx.db.select().from(audit).orderBy(desc(audit.at), desc(audit.id)).limit(limit).all();
}

export type AuditRow = ReturnType<typeof listAudit>[number];

/** The portal's audit rows from `from` to `to` (unix ms), oldest first, at most `limit` (plan N2a: beside a core's audit). */
export function auditBetween(ctx: Ctx, from: number, to: number, limit = 2000): AuditRow[] {
  return ctx.db
    .select()
    .from(audit)
    .where(and(gte(audit.at, from), lte(audit.at, to)))
    .orderBy(asc(audit.at), asc(audit.id))
    .limit(limit)
    .all();
}
