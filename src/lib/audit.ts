import { and, asc, desc, eq, gte, lt, lte } from 'drizzle-orm';
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

export interface AuditFilter {
  action?: string;
  actor?: number;
  target?: string;
  /** Rows older than this id (the `next` of the page before). */
  before?: number;
}

/** One page of the portal's audit, newest first, for /admin/audit. */
export function auditPage(ctx: Ctx, f: AuditFilter, limit = 100): { rows: AuditRow[]; next: number | null } {
  const rows = ctx.db
    .select()
    .from(audit)
    .where(
      and(
        f.action ? eq(audit.action, f.action) : undefined,
        f.actor !== undefined ? eq(audit.actorId, f.actor) : undefined,
        f.target ? eq(audit.target, f.target) : undefined,
        f.before !== undefined ? lt(audit.id, f.before) : undefined,
      ),
    )
    .orderBy(desc(audit.id))
    .limit(limit + 1)
    .all();
  return { rows: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null };
}
