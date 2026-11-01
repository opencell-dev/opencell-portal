import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { isCoreError } from '@/core/types';
import { nodeRequests, nodes, nodeState, numbers, users } from '@/db/schema';
import type { Result } from '@/lib/accounts';
import { writeAudit } from '@/lib/audit';
import { tryWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { errorKind } from '@/lib/errors';
import { nodeApprovedMail, nodeDeclinedMail } from '@/lib/mail-templates';
import type { Side } from '@/lib/numbers/homing';
import type { RequestMeta } from '@/lib/sessions';
import { coreActor } from '@/lib/site';
import { getUser, grantRole } from '@/lib/users';
import { firstError, isOneLinePlain } from '@/lib/validation';
import { nearestNode, nearestRateCenter } from './geo';
import { cellName, certCn, newCellSeed, pickAnchor } from './radio-plan';
import { currentRelease } from './release';
import { type NodeRequest, NOT_ON_THIS_SITE, OPEN_STATUSES, type RequestStatus, type ThreadMessage, threadOf } from './requests';
import { cellCoreFor } from './route';
import { makeSetupToken, setupCommand } from './setup-tokens';

// The admins' queue (portal spec §6.2): the requester's history, the site, the
// nearest cell and the target core; then approve, decline, or ask (requests.ts).
// Pages and actions check the admin; these take the admin's id.

const DECIDED = 'Someone already decided this request.';
const WRITE_MS = 5000;

export function reviewQueue(ctx: Ctx): { id: number; siteName: string; region: string; requester: string; createdAt: number; status: RequestStatus }[] {
  return ctx.db
    .select({ id: nodeRequests.id, siteName: nodeRequests.siteName, region: nodeRequests.region, name: users.name, email: users.email, createdAt: nodeRequests.createdAt, status: nodeRequests.status })
    .from(nodeRequests)
    .innerJoin(users, eq(users.id, nodeRequests.userId))
    .where(inArray(nodeRequests.status, [...OPEN_STATUSES]))
    .orderBy(asc(nodeRequests.createdAt), asc(nodeRequests.id))
    .all()
    .map(({ name, email, ...r }) => ({ ...r, requester: `${name} (${email})` }));
}

export interface ReviewDetail {
  request: NodeRequest;
  requester: {
    id: number;
    name: string;
    email: string;
    verifiedAt: number | null;
    since: number;
    numbers: number;
    activated: number;
    disabled: boolean;
    requests: Record<RequestStatus, number>;
  };
  nearestNode: { nodeId: number; cellName: string; km: number } | null;
  rateCenter: { region: string; name: string; km: number; matches: boolean } | null;
  target: { coreId: string | null; side: Side | null; note: string | null };
  cores: { id: string; cellAddr: string }[];
  suggestedAnchor: number;
  thread: ThreadMessage[];
}

/** Everything §6.2 lists for one request, or null. Admins only: it holds the exact pin and the contact phone. */
export function reviewDetail(ctx: Ctx, id: number): ReviewDetail | null {
  const request = ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, id)).get();
  if (!request) return null;
  const u = getUser(ctx, request.userId);
  if (!u) return null;
  const held = ctx.db.select({ n: count() }).from(numbers).where(eq(numbers.userId, u.id)).get()!.n;
  const activated = ctx.db.select({ n: count() }).from(numbers).where(and(eq(numbers.userId, u.id), eq(numbers.state, 'activated'))).get()!.n;
  const requests: Record<RequestStatus, number> = { pending: 0, question: 0, approved: 0, declined: 0, withdrawn: 0 };
  for (const r of ctx.db.select({ s: nodeRequests.status, n: count() }).from(nodeRequests).where(eq(nodeRequests.userId, u.id)).groupBy(nodeRequests.status).all()) requests[r.s] = r.n;
  const rc = nearestRateCenter(ctx, request);
  let target: ReviewDetail['target'];
  try {
    const t = cellCoreFor(ctx, request.region);
    target = { coreId: t.handle.id, side: t.side, note: t.note };
  } catch {
    target = { coreId: null, side: null, note: 'No core takes cells: set OC_CORE_<ID>_CELLS.' };
  }
  return {
    request,
    requester: { id: u.id, name: u.name, email: u.email, verifiedAt: u.emailVerifiedAt, since: u.createdAt, numbers: held, activated, disabled: u.disabledAt !== null, requests },
    nearestNode: nearestNode(ctx, request),
    rateCenter: rc && { ...rc, matches: rc.region === request.region },
    target,
    cores: ctx.cores.flatMap((h) => (h.cellAddr ? [{ id: h.id, cellAddr: h.cellAddr }] : [])),
    suggestedAnchor: pickAnchor(ctx),
    thread: threadOf(ctx, id),
  };
}

const noteSchema = z
  .string('Please write a note.')
  .max(4000, { error: 'Please keep the note under 1000 characters.', abort: true })
  .trim()
  .min(1, { error: 'Please write a note.', abort: true })
  .max(1000, { error: 'Please keep the note under 1000 characters.', abort: true })
  .refine((s) => s.split(/\r?\n/).every(isOneLinePlain), 'Please use plain text.');

/** Close a request with a note the requester is mailed. */
export function declineRequest(ctx: Ctx, adminId: number, id: number, note: unknown, meta: RequestMeta): Result {
  if (ctx.config.site !== 'portal') return { ok: false, error: NOT_ON_THIS_SITE };
  const p = noteSchema.safeParse(note);
  if (!p.success) return { ok: false, error: firstError(p.error) };
  const now = ctx.now();
  const claimed = ctx.db
    .update(nodeRequests)
    .set({ status: 'declined', decidedAt: now, decidedBy: adminId, declineNote: p.data })
    .where(and(eq(nodeRequests.id, id), inArray(nodeRequests.status, [...OPEN_STATUSES])))
    .returning()
    .get();
  if (!claimed) return { ok: false, error: DECIDED };
  writeAudit(ctx, { actorId: adminId, action: 'node.decline', target: `node_request:${id}`, ip: meta.ip });
  const u = getUser(ctx, claimed.userId);
  if (u) {
    const m = nodeDeclinedMail(u.name, claimed.siteName, p.data, ctx.config.origin);
    ctx.mailQueue.send({ to: u.email, subject: m.subject, text: m.text });
  }
  return { ok: true };
}

export const approveSchema = z.object({
  coreId: z.string().min(1).max(16),
  anchor: z.number().int().min(0).max(51),
  boardRole: z.enum(['bs', 'bench']),
});

/** Revoke a cell the core made that no node row holds, and leave a trace: nothing may stay pinned-able and unowned. */
function orphan(ctx: Ctx, h: { id: string; core: { cellRevoke(actor: number, cellId: number): Promise<void> } }, actor: number, adminId: number, cellId: number, requestId: number, meta: RequestMeta): void {
  void h.core.cellRevoke(actor, cellId).then(
    () => writeAudit(ctx, { actorId: adminId, action: 'node.approve_orphan', target: `node_request:${requestId}`, detail: { core: h.id, cell: cellId, revoked: true }, ip: meta.ip }),
    (e: unknown) => {
      console.error(`oc-portal: cell ${cellId} on ${h.id} has no node and could not be revoked (${errorKind(e)})`);
      writeAudit(ctx, { actorId: adminId, action: 'node.approve_orphan', target: `node_request:${requestId}`, detail: { core: h.id, cell: cellId, revoked: false }, ip: meta.ip });
    },
  );
}

/**
 * Approve (spec §6.2). The request is claimed first, in one UPDATE, so a double
 * click makes one cell; a core that fails gives it back as it was. Then
 * cell.add (Part 15, group 0), the node, the operator role, and a setup token
 * if a release is published (decision 4); the requester is mailed the command.
 */
export async function approveRequest(ctx: Ctx, adminId: number, id: number, opts: unknown, meta: RequestMeta, tuning: { deadlineMs?: number } = {}): Promise<Result<{ nodeId: number; cellId: number; tokenMade: boolean }>> {
  if (ctx.config.site !== 'portal') return { ok: false, error: NOT_ON_THIS_SITE };
  const p = approveSchema.safeParse(opts);
  if (!p.success) return { ok: false, error: 'Please choose a core, an anchor from 0 to 51 and a board role.' };
  const { coreId, anchor, boardRole } = p.data;
  const row = ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, id)).get();
  if (!row) return { ok: false, error: 'No such request.' };
  const u = getUser(ctx, row.userId);
  if (!u || u.disabledAt !== null) return { ok: false, error: 'This account is disabled: enable it first.' };
  let handle;
  try {
    handle = cellCoreFor(ctx, row.region, coreId).handle;
  } catch {
    return { ok: false, error: 'No core takes cells.' };
  }
  if (handle.id !== coreId) return { ok: false, error: `${coreId} takes no cells. Choose a core with a cell address.` };
  const now = ctx.now();
  const claimed = ctx.db
    .update(nodeRequests)
    .set({ status: 'approved', decidedAt: now, decidedBy: adminId })
    .where(and(eq(nodeRequests.id, id), inArray(nodeRequests.status, [...OPEN_STATUSES])))
    .run();
  if (claimed.changes !== 1) return { ok: false, error: DECIDED };
  const restore = () => ctx.db.update(nodeRequests).set({ status: row.status, decidedAt: null, decidedBy: null }).where(eq(nodeRequests.id, id)).run();
  const actor = coreActor(ctx.config.site, adminId);
  const name = cellName(row.siteName);
  const added = await tryWithin(handle, 'cell.add', () => handle.core.cellAdd(actor, name, 'part15', 0), tuning.deadlineMs ?? WRITE_MS, (late) => {
    // The page gave up, but the core made the cell after all.
    if (late.ok) orphan(ctx, handle, actor, adminId, late.value, id, meta);
  });
  if (!added.ok) {
    restore();
    const refused = 'error' in added && isCoreError(added.error) && added.error.code !== 'unavailable';
    return { ok: false, error: refused ? `Core ${handle.coreNo} refused the new cell; nothing was created.` : `Core ${handle.coreNo} didn't answer; nothing was created.` };
  }
  const cellId = added.value;
  let nodeId: number;
  try {
    nodeId = ctx.db.transaction(() => {
      const n = ctx.db
        .insert(nodes)
        .values({
          requestId: id,
          userId: row.userId,
          coreId: handle.id,
          cellId,
          cellName: name,
          certCn: certCn(cellId, name),
          siteName: row.siteName,
          lat: row.lat,
          lon: row.lon,
          region: row.region,
          contactPhone: row.contactPhone,
          anchor,
          cellSeed: newCellSeed(),
          boardRole,
          mode: 'part15',
          listGroup: 0,
          createdAt: now,
        })
        .returning({ id: nodes.id })
        .get();
      ctx.db.insert(nodeState).values({ nodeId: n.id, online: null, checkedAt: now }).run();
      ctx.db.update(nodeRequests).set({ nodeId: n.id }).where(eq(nodeRequests.id, id)).run();
      grantRole(ctx, row.userId, 'operator', adminId);
      return n.id;
    });
  } catch (e) {
    console.error(`oc-portal: approving request ${id}: the node could not be stored (${errorKind(e)})`);
    restore();
    orphan(ctx, handle, actor, adminId, cellId, id, meta);
    return { ok: false, error: 'The node could not be stored, so its cell is being revoked. Please try again.' };
  }
  const rel = currentRelease(ctx);
  const token = rel ? makeSetupToken(ctx, nodeId, adminId) : null;
  writeAudit(ctx, { actorId: adminId, action: 'node.approve', target: `node:${nodeId}`, detail: { core: handle.id, cell: cellId, anchor }, ip: meta.ip });
  const m = nodeApprovedMail(u.name, row.siteName, token && setupCommand(ctx, token.token), token?.expiresAt ?? null, `${ctx.config.origin}/nodes/${nodeId}`, ctx.config.origin);
  ctx.mailQueue.send({ to: u.email, subject: m.subject, text: m.text });
  return { ok: true, nodeId, cellId, tokenMade: token !== null };
}

