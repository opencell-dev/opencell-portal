import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { limitRequests, userRoles, users } from '@/db/schema';
import type { Result } from '@/lib/accounts';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { limitDecisionMail, limitRequestMail } from '@/lib/mail-templates';
import { hit } from '@/lib/ratelimit';
import type { RequestMeta } from '@/lib/sessions';
import { firstError, isOneLinePlain } from '@/lib/validation';
import { heldCount } from './ownership';

// Above the limit (portal spec §4.2): the "Get a number" card asks for a
// short reason, and an admin raises the account's limit or declines, on
// /admin/limits (P2 decision 5). The subscriber is mailed either way.

/** The highest limit an admin can set here. */
export const MAX_LIMIT = 20;

// Plain text, one or more lines: each line the same check as a name (no
// control or invisible format characters), since it reaches mail and the admin page.
const text = (min: number, max: number, what: string) =>
  z
    .string()
    .max(max * 4, { error: `Please keep the ${what} under ${max} characters.`, abort: true })
    .trim()
    .min(min, { error: `Please write at least ${min} characters for the ${what}.`, abort: true })
    .max(max, { error: `Please keep the ${what} under ${max} characters.`, abort: true })
    .refine((s) => s.split(/\r?\n/).every(isOneLinePlain), `Please use plain text for the ${what}.`);

const requestSchema = z.object({ reason: text(10, 500, 'reason'), wanted: z.coerce.number().int() });

export type LimitRequest = typeof limitRequests.$inferSelect;

export function pendingRequestOf(ctx: Ctx, userId: number): LimitRequest | undefined {
  return ctx.db
    .select()
    .from(limitRequests)
    .where(and(eq(limitRequests.userId, userId), isNull(limitRequests.decidedAt)))
    .get();
}

/** Ask for more numbers: one pending request per account; every admin is mailed. */
export function requestMoreNumbers(ctx: Ctx, userId: number, input: { reason: unknown; wanted: unknown }, meta: RequestMeta): Result {
  const p = requestSchema.safeParse(input);
  if (!p.success) return { ok: false, error: firstError(p.error) };
  const u = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!u) return { ok: false, error: 'No such account.' };
  const { reason, wanted } = p.data;
  // Only at the limit: below it there is nothing to ask for (the card shows the form only then).
  const left = u.numberLimit - heldCount(ctx, userId);
  if (left > 0) return { ok: false, error: `You can still get ${left} more without asking.` };
  if (wanted <= u.numberLimit || wanted > MAX_LIMIT) return { ok: false, error: `Ask for ${u.numberLimit + 1} to ${MAX_LIMIT} numbers in all.` };
  if (pendingRequestOf(ctx, userId)) return { ok: false, error: 'You have asked already: an admin will answer by email.' };
  const lim = hit(ctx, 'limit_request_account', String(userId));
  if (!lim.ok) return { ok: false, error: lim.message };
  ctx.db.insert(limitRequests).values({ userId, reason, wanted, createdAt: ctx.now() }).run();
  writeAudit(ctx, { actorId: userId, action: 'limit.request', target: `user:${userId}`, detail: { wanted }, ip: meta.ip });
  const admins = ctx.db
    .select({ name: users.name, email: users.email })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(eq(userRoles.role, 'admin'))
    .all();
  for (const a of admins) {
    const m = limitRequestMail(a.name, `${u.name} (${u.email})`, wanted, reason, ctx.config.origin);
    ctx.mailQueue.send({ to: a.email, subject: m.subject, text: m.text });
  }
  return { ok: true };
}

export interface PendingRequest {
  id: number;
  userId: number;
  name: string;
  email: string;
  verified: boolean;
  subscriberSince: number;
  held: number;
  limit: number;
  wanted: number;
  reason: string;
  createdAt: number;
  /** Earlier decisions for this account, newest first. */
  history: { decidedAt: number; outcome: 'raised' | 'declined'; note: string | null }[];
}

/** The admin page's queue, oldest first, with what an admin needs to decide. */
export function pendingLimitRequests(ctx: Ctx): PendingRequest[] {
  const rows = ctx.db
    .select({ r: limitRequests, u: users })
    .from(limitRequests)
    .innerJoin(users, eq(users.id, limitRequests.userId))
    .where(isNull(limitRequests.decidedAt))
    .orderBy(asc(limitRequests.createdAt), asc(limitRequests.id))
    .all();
  return rows.map(({ r, u }) => ({
    id: r.id,
    userId: u.id,
    name: u.name,
    email: u.email,
    verified: u.emailVerifiedAt !== null,
    subscriberSince: u.emailVerifiedAt ?? u.createdAt,
    held: heldCount(ctx, u.id),
    limit: u.numberLimit,
    wanted: r.wanted,
    reason: r.reason,
    createdAt: r.createdAt,
    history: ctx.db
      .select()
      .from(limitRequests)
      .where(eq(limitRequests.userId, u.id))
      .all()
      .filter((h) => h.decidedAt !== null && h.outcome !== null)
      .sort((a, b) => b.decidedAt! - a.decidedAt!)
      .map((h) => ({ decidedAt: h.decidedAt!, outcome: h.outcome!, note: h.note })),
  }));
}

export type Decision = { outcome: 'raised'; limit: number } | { outcome: 'declined'; note: string };

const noteSchema = text(1, 500, 'note');

/** Raise the account's limit (above today's, at most 20) or decline with a note; the subscriber is mailed. */
export function decideLimitRequest(ctx: Ctx, adminId: number, id: number, d: Decision, meta: RequestMeta): Result {
  const req = ctx.db.select().from(limitRequests).where(eq(limitRequests.id, id)).get();
  if (!req || req.decidedAt !== null) return { ok: false, error: 'That request is not waiting for a decision.' };
  const u = ctx.db.select().from(users).where(eq(users.id, req.userId)).get();
  if (!u) return { ok: false, error: 'That account is gone.' };
  let note: string | null = null;
  let limit = u.numberLimit;
  if (d.outcome === 'raised') {
    if (!Number.isInteger(d.limit) || d.limit <= u.numberLimit || d.limit > MAX_LIMIT) {
      return { ok: false, error: `Raise to ${u.numberLimit + 1}–${MAX_LIMIT}.` };
    }
    limit = d.limit;
  } else {
    const p = noteSchema.safeParse(d.note);
    if (!p.success) return { ok: false, error: firstError(p.error) };
    note = p.data;
  }
  const now = ctx.now();
  const done = ctx.db.transaction((tx) => {
    const claimed = tx
      .update(limitRequests)
      .set({ decidedAt: now, decidedBy: adminId, outcome: d.outcome, note })
      .where(and(eq(limitRequests.id, id), isNull(limitRequests.decidedAt)))
      .run();
    if (claimed.changes !== 1) return false;
    if (d.outcome === 'raised') tx.update(users).set({ numberLimit: limit }).where(eq(users.id, u.id)).run();
    return true;
  });
  if (!done) return { ok: false, error: 'That request is not waiting for a decision.' };
  writeAudit(ctx, { actorId: adminId, action: 'limit.decide', target: `user:${u.id}`, detail: { request: id, outcome: d.outcome, limit }, ip: meta.ip });
  const m = limitDecisionMail(u.name, d.outcome === 'raised', limit, note, ctx.config.origin);
  ctx.mailQueue.send({ to: u.email, subject: m.subject, text: m.text });
  return { ok: true };
}
