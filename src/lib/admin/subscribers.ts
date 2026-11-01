import { and, asc, count, eq, or, sql } from 'drizzle-orm';
import { isCoreError } from '@/core/types';
import { nodeRequests, nodes, numbers, sessions, users } from '@/db/schema';
import type { Result } from '@/lib/accounts';
import { acceptedVersion } from '@/lib/agreement';
import { writeAudit } from '@/lib/audit';
import { tryWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { accountDisabledMail, accountEnabledMail } from '@/lib/mail-templates';
import { type NumberRow } from '@/lib/numbers/ownership';
import { coreFor } from '@/lib/numbers/route';
import { voidTokensOfUser } from '@/lib/nodes/setup-tokens';
import { endSessionsOfDisabled, type RequestMeta } from '@/lib/sessions';
import { coreActor } from '@/lib/site';
import { getUser, isLastAdmin, type Role, rolesOf, type User } from '@/lib/users';

// Admins and subscribers (portal spec §1, §10; plan P3, decision 22). Disabling
// an account ends its sessions and disables each of its numbers on the number's
// home core. Which numbers it disabled is on the rows, so enabling reverses only
// those, and any step can be run again: a core that failed is listed, not fatal.

const SEARCH_MAX = 64;
export const SUBSCRIBERS_PAGE = 50;
const WRITE_MS = 5000;
const NOT_HERE = 'Subscribers are handled on the subscriber portal.';

const likeAny = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface SubscriberRow {
  id: number;
  name: string;
  email: string;
  since: number;
  verified: boolean;
  disabled: boolean;
  numbers: number;
  roles: Role[];
}

export function searchSubscribers(ctx: Ctx, q: string, page: number): { rows: SubscriberRow[]; more: boolean } {
  const query = q.normalize('NFKC').trim();
  if (query.length > SEARCH_MAX) return { rows: [], more: false };
  const p = Number.isInteger(page) && page >= 1 ? page : 1;
  const digits = query.replace(/[\s\-().+]/g, '');
  const byDigits = /^\d+$/.test(digits) ? digits.replace(/^8831/, '') : null;
  const match =
    query === ''
      ? undefined
      : or(
          sql`lower(${users.name}) LIKE lower(${likeAny(query)}) ESCAPE '\\'`,
          sql`lower(${users.email}) LIKE lower(${likeAny(query)}) ESCAPE '\\'`,
          byDigits ? sql`EXISTS (SELECT 1 FROM ${numbers} WHERE ${numbers.userId} = ${users.id} AND ${numbers.number} LIKE ${likeAny(byDigits)} ESCAPE '\\')` : undefined,
        );
  const rows = ctx.db
    .select()
    .from(users)
    .where(match)
    .orderBy(asc(users.id))
    .limit(SUBSCRIBERS_PAGE + 1)
    .offset((p - 1) * SUBSCRIBERS_PAGE)
    .all();
  return {
    rows: rows.slice(0, SUBSCRIBERS_PAGE).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      since: u.createdAt,
      verified: u.emailVerifiedAt !== null,
      disabled: u.disabledAt !== null,
      numbers: ctx.db.select({ n: count() }).from(numbers).where(eq(numbers.userId, u.id)).get()!.n,
      roles: rolesOf(ctx, u.id),
    })),
    more: rows.length > SUBSCRIBERS_PAGE,
  };
}

export function subscriberDetail(
  ctx: Ctx,
  id: number,
): { user: User; roles: Role[]; numbers: NumberRow[]; requests: (typeof nodeRequests.$inferSelect)[]; nodes: (typeof nodes.$inferSelect)[]; sessions: number; agreement: number | null } | null {
  const user = getUser(ctx, id);
  if (!user) return null;
  return {
    user,
    roles: rolesOf(ctx, id),
    numbers: ctx.db.select().from(numbers).where(eq(numbers.userId, id)).orderBy(asc(numbers.number)).all(),
    requests: ctx.db.select().from(nodeRequests).where(eq(nodeRequests.userId, id)).orderBy(asc(nodeRequests.id)).all(),
    nodes: ctx.db.select().from(nodes).where(eq(nodes.userId, id)).orderBy(asc(nodes.id)).all(),
    sessions: ctx.db.select({ n: count() }).from(sessions).where(eq(sessions.userId, id)).get()!.n,
    agreement: acceptedVersion(ctx, id),
  };
}

/** One number's state at its home core; a number the core no longer holds has nothing left to change. */
async function setAtCore(ctx: Ctx, adminId: number, number: string, disabled: boolean): Promise<boolean> {
  const h = coreFor(ctx, number);
  const actor = coreActor(ctx.config.site, adminId);
  const r = await tryWithin(h, disabled ? 'sub.disable' : 'sub.enable', () => (disabled ? h.core.subDisable(actor, number) : h.core.subEnable(actor, number)), WRITE_MS);
  return r.ok || ('error' in r && isCoreError(r.error) && r.error.code === 'not_found');
}

export type AccountOutcome = Result<{ numbers: { number: string; ok: boolean }[] }>;

export async function disableAccount(ctx: Ctx, adminId: number, userId: number, meta: RequestMeta): Promise<AccountOutcome> {
  if (ctx.config.site !== 'portal') return { ok: false, error: NOT_HERE };
  if (adminId === userId) return { ok: false, error: 'You cannot disable your own account.' };
  const u = getUser(ctx, userId);
  if (!u) return { ok: false, error: 'No such account.' };
  if (isLastAdmin(ctx, userId)) return { ok: false, error: 'That is the last admin: promote another admin first.' };
  const first = u.disabledAt === null;
  if (first) {
    ctx.db.transaction(() => {
      ctx.db.update(users).set({ disabledAt: ctx.now(), disabledBy: adminId }).where(eq(users.id, userId)).run();
      endSessionsOfDisabled(ctx, userId);
      voidTokensOfUser(ctx, userId);
    });
  }
  const rows = ctx.db.select({ number: numbers.number }).from(numbers).where(and(eq(numbers.userId, userId), eq(numbers.disabled, false))).all();
  const results = await Promise.all(
    rows.map(async ({ number }) => {
      const ok = await setAtCore(ctx, adminId, number, true);
      if (ok) ctx.db.update(numbers).set({ disabled: true, disabledBy: 'account' }).where(eq(numbers.number, number)).run();
      return { number, ok };
    }),
  );
  writeAudit(ctx, { actorId: adminId, action: 'account.disable', target: `user:${userId}`, detail: { numbers: results }, ip: meta.ip });
  if (first) {
    const m = accountDisabledMail(u.name, ctx.config.origin);
    ctx.mailQueue.send({ to: u.email, subject: m.subject, text: m.text });
  }
  return { ok: true, numbers: results };
}

export async function enableAccount(ctx: Ctx, adminId: number, userId: number, meta: RequestMeta): Promise<AccountOutcome> {
  if (ctx.config.site !== 'portal') return { ok: false, error: NOT_HERE };
  const u = getUser(ctx, userId);
  if (!u) return { ok: false, error: 'No such account.' };
  const first = u.disabledAt !== null;
  if (first) ctx.db.update(users).set({ disabledAt: null, disabledBy: null }).where(eq(users.id, userId)).run();
  const rows = ctx.db.select({ number: numbers.number }).from(numbers).where(and(eq(numbers.userId, userId), eq(numbers.disabledBy, 'account'))).all();
  const results = await Promise.all(
    rows.map(async ({ number }) => {
      const ok = await setAtCore(ctx, adminId, number, false);
      if (ok) ctx.db.update(numbers).set({ disabled: false, disabledBy: null }).where(eq(numbers.number, number)).run();
      return { number, ok };
    }),
  );
  writeAudit(ctx, { actorId: adminId, action: 'account.enable', target: `user:${userId}`, detail: { numbers: results }, ip: meta.ip });
  if (first) {
    const m = accountEnabledMail(u.name, ctx.config.origin);
    ctx.mailQueue.send({ to: u.email, subject: m.subject, text: m.text });
  }
  return { ok: true, numbers: results };
}

/** One number by itself: an admin's, so enabling the account leaves it as it is. */
export async function setNumberDisabled(ctx: Ctx, adminId: number, number: string, disabled: boolean, meta: RequestMeta): Promise<Result> {
  if (ctx.config.site !== 'portal') return { ok: false, error: NOT_HERE };
  const row = ctx.db.select().from(numbers).where(eq(numbers.number, number)).get();
  if (!row) return { ok: false, error: 'No account holds that number.' };
  if (!(await setAtCore(ctx, adminId, number, disabled))) return { ok: false, error: "The network didn't answer. Please try again in a minute." };
  ctx.db.update(numbers).set({ disabled, disabledBy: disabled ? 'admin' : null }).where(eq(numbers.number, number)).run();
  writeAudit(ctx, { actorId: adminId, action: disabled ? 'number.disable' : 'number.enable', target: `number:${number}`, detail: { user: row.userId }, ip: meta.ip });
  return { ok: true };
}

