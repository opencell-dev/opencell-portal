import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AGREEMENT_VERSION } from '@/content/operator-agreement';
import { nodeRequestMessages, nodeRequests, users } from '@/db/schema';
import type { Result } from '@/lib/accounts';
import { acceptAgreement } from '@/lib/agreement';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { nodeQuestionMail, nodeReplyMail, nodeRequestMail } from '@/lib/mail-templates';
import { REGION_CODES, sideOfRegion } from '@/lib/numbers/homing';
import { hit } from '@/lib/ratelimit';
import type { RequestMeta } from '@/lib/sessions';
import { adminContacts, getUser } from '@/lib/users';
import { firstError, isOneLinePlain } from '@/lib/validation';
import { pinSchema } from './geo';

// A subscriber asks to host a base station (portal spec §6.1) and talks to the
// admins in the request's thread (§6.2). Nothing here returns another
// account's request: anyone else's is "no such request".

export type NodeRequest = typeof nodeRequests.$inferSelect;
export type RequestStatus = NodeRequest['status'];

export const OPEN_STATUSES = ['pending', 'question'] as const;
export const MAX_OPEN_REQUESTS = 2;
export const NOT_ON_THIS_SITE = 'Base stations are handled on the subscriber portal.';

const NO_REQUEST = 'You have no such request.';

/** One line of plain text, `min` to `max` characters; what it is goes in the messages. */
export const plain = (min: number, max: number, what: string) =>
  z
    .string(`Please enter the ${what}.`)
    .max(max * 4, { error: `Please keep the ${what} under ${max} characters.`, abort: true })
    .trim()
    .min(min, { error: `Please write at least ${min} characters for the ${what}.`, abort: true })
    .max(max, { error: `Please keep the ${what} under ${max} characters.`, abort: true })
    .refine(isOneLinePlain, `Please use plain text for the ${what}, on one line.`);

export const requestSchema = pinSchema.extend({
  siteName: plain(3, 60, 'site name'),
  region: z.string('Please pick the state or province.').refine((r) => sideOfRegion(r) !== null, 'Please pick the state or province.'),
  piModel: z.enum(['pi5', 'pi4', 'pi3', 'other'], 'Please pick the Pi model.'),
  w12Boards: z.coerce.number('Please say how many boards.').int('Please say how many boards.').min(1, 'One to four boards, please.').max(4, 'One to four boards, please.'),
  gps: z.boolean(),
  antenna: plain(2, 120, 'antenna'),
  backhaul: z.enum(['home', 'cellular', 'other'], 'Please pick how the node reaches the internet.'),
  power: z.enum(['mains', 'mains_battery', 'solar'], 'Please pick how the node gets its power.'),
  contactPhone: z.string('Please enter a contact phone.').regex(/^\+?[0-9 ().-]{7,20}$/, 'Please enter a contact phone: digits, spaces and + ( ) . - only.'),
  agree: z.literal(true, 'Please accept the Base Station Operator Agreement.'),
  agreementVersion: z.literal(AGREEMENT_VERSION, 'The agreement has changed: please read it again.'),
});

export const messageSchema = z
  .string('Please write a message.')
  .max(8000, { error: 'Please keep it under 2000 characters.', abort: true })
  .trim()
  .min(1, { error: 'Please write a message.', abort: true })
  .max(2000, { error: 'Please keep it under 2000 characters.', abort: true })
  .refine((s) => s.split(/\r?\n/).every(isOneLinePlain), 'Please use plain text.');

export { REGION_CODES };

function openCount(ctx: Ctx, userId: number): number {
  return ctx.db
    .select({ n: count() })
    .from(nodeRequests)
    .where(and(eq(nodeRequests.userId, userId), inArray(nodeRequests.status, [...OPEN_STATUSES])))
    .get()!.n;
}

/** Whether this account can open another request now (the page hides the link at the limit). */
export function canRequest(ctx: Ctx, userId: number): boolean {
  return openCount(ctx, userId) < MAX_OPEN_REQUESTS;
}

/** A request, with the agreement accepted in the same step, and every admin told. */
export function submitRequest(ctx: Ctx, userId: number, input: unknown, meta: RequestMeta): Result<{ id: number }> {
  if (ctx.config.site !== 'portal') return { ok: false, error: NOT_ON_THIS_SITE };
  const p = requestSchema.safeParse(input);
  if (!p.success) return { ok: false, error: firstError(p.error) };
  const u = getUser(ctx, userId);
  if (!u?.emailVerifiedAt) return { ok: false, error: 'Please confirm your email address first.' };
  if (!canRequest(ctx, userId)) return { ok: false, error: `You can have at most ${MAX_OPEN_REQUESTS} open requests: an admin will answer those first.` };
  const lim = hit(ctx, 'node_request', String(userId));
  if (!lim.ok) return { ok: false, error: lim.message };
  const d = p.data;
  const now = ctx.now();
  const id = ctx.db.transaction(() => {
    const row = ctx.db
      .insert(nodeRequests)
      .values({
        userId,
        siteName: d.siteName,
        lat: d.lat,
        lon: d.lon,
        region: d.region,
        piModel: d.piModel,
        w12Boards: d.w12Boards,
        gps: d.gps,
        antenna: d.antenna,
        backhaul: d.backhaul,
        power: d.power,
        contactPhone: d.contactPhone,
        agreementVersion: d.agreementVersion,
        agreedAt: now,
        status: 'pending',
        createdAt: now,
      })
      .returning({ id: nodeRequests.id })
      .get();
    acceptAgreement(ctx, userId, d.agreementVersion, meta);
    writeAudit(ctx, { actorId: userId, action: 'node.request', target: `node_request:${row.id}`, detail: { region: d.region }, ip: meta.ip });
    return row.id;
  });
  const link = `${ctx.config.origin}/admin/requests/${id}`;
  for (const a of adminContacts(ctx)) {
    const m = nodeRequestMail(a.name, `${u.name} (${u.email})`, d.siteName, d.region, link, ctx.config.origin);
    ctx.mailQueue.send({ to: a.email, subject: m.subject, text: m.text });
  }
  return { ok: true, id };
}

export function listMyRequests(ctx: Ctx, userId: number): NodeRequest[] {
  return ctx.db.select().from(nodeRequests).where(eq(nodeRequests.userId, userId)).orderBy(desc(nodeRequests.createdAt), desc(nodeRequests.id)).all();
}

export type ThreadMessage = { id: number; fromAdmin: boolean; body: string; at: number };

/** A request's thread, oldest first. Which admin wrote is not the requester's business: the admin page reads the rows itself. */
export function threadOf(ctx: Ctx, requestId: number): ThreadMessage[] {
  return ctx.db
    .select({ id: nodeRequestMessages.id, fromAdmin: nodeRequestMessages.fromAdmin, body: nodeRequestMessages.body, at: nodeRequestMessages.at })
    .from(nodeRequestMessages)
    .where(eq(nodeRequestMessages.requestId, requestId))
    .orderBy(asc(nodeRequestMessages.at), asc(nodeRequestMessages.id))
    .all();
}

/** The account's own request with its thread, or null for anyone else's. */
export function getMyRequest(ctx: Ctx, userId: number, id: number): (NodeRequest & { thread: ThreadMessage[] }) | null {
  const row = ctx.db.select().from(nodeRequests).where(and(eq(nodeRequests.id, id), eq(nodeRequests.userId, userId))).get();
  return row ? { ...row, thread: threadOf(ctx, id) } : null;
}

export function withdrawRequest(ctx: Ctx, userId: number, id: number, meta: RequestMeta): Result {
  if (ctx.config.site !== 'portal') return { ok: false, error: NOT_ON_THIS_SITE };
  const done = ctx.db
    .update(nodeRequests)
    .set({ status: 'withdrawn', decidedAt: ctx.now(), decidedBy: userId })
    .where(and(eq(nodeRequests.id, id), eq(nodeRequests.userId, userId), inArray(nodeRequests.status, [...OPEN_STATUSES])))
    .run();
  if (done.changes !== 1) return { ok: false, error: NO_REQUEST };
  writeAudit(ctx, { actorId: userId, action: 'node.withdraw', target: `node_request:${id}`, ip: meta.ip });
  return { ok: true };
}

/**
 * One message in a request's thread. From an admin (the caller has checked the
 * role): the request waits for an answer, and the requester is mailed. From the
 * requester, who alone may reply: an answer to a question puts it back in the
 * queue and tells the admins; anything more only joins the thread.
 */
export function postMessage(ctx: Ctx, m: { requestId: number; authorId: number; fromAdmin: boolean; body: unknown }, meta: RequestMeta): Result {
  if (ctx.config.site !== 'portal') return { ok: false, error: NOT_ON_THIS_SITE };
  const p = messageSchema.safeParse(m.body);
  if (!p.success) return { ok: false, error: firstError(p.error) };
  const row = ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, m.requestId)).get();
  if (!row || (!m.fromAdmin && row.userId !== m.authorId)) return { ok: false, error: NO_REQUEST };
  if (!OPEN_STATUSES.includes(row.status as (typeof OPEN_STATUSES)[number])) return { ok: false, error: 'This request is closed.' };
  const lim = hit(ctx, 'node_message', String(m.authorId));
  if (!lim.ok) return { ok: false, error: lim.message };
  const body = p.data;
  const status = m.fromAdmin ? 'question' : row.status === 'question' ? 'pending' : row.status;
  ctx.db.transaction(() => {
    ctx.db.insert(nodeRequestMessages).values({ requestId: row.id, authorId: m.authorId, fromAdmin: m.fromAdmin, body, at: ctx.now() }).run();
    ctx.db.update(nodeRequests).set({ status }).where(eq(nodeRequests.id, row.id)).run();
    writeAudit(ctx, { actorId: m.authorId, action: m.fromAdmin ? 'node.ask' : 'node.reply', target: `node_request:${row.id}`, ip: meta.ip });
  });
  const requester = ctx.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, row.userId)).get();
  if (m.fromAdmin && requester) {
    const t = nodeQuestionMail(requester.name, row.siteName, body, `${ctx.config.origin}/nodes/requests/${row.id}`, ctx.config.origin);
    ctx.mailQueue.send({ to: requester.email, subject: t.subject, text: t.text });
  } else if (!m.fromAdmin && row.status === 'question' && requester) {
    const link = `${ctx.config.origin}/admin/requests/${row.id}`;
    for (const a of adminContacts(ctx)) {
      const t = nodeReplyMail(a.name, `${requester.name} (${requester.email})`, row.siteName, link, ctx.config.origin);
      ctx.mailQueue.send({ to: a.email, subject: t.subject, text: t.text });
    }
  }
  return { ok: true };
}
