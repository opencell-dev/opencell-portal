import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { CellMode, CellStatus, RadioStatus } from '@/core/types';
import { nodeDowntime, nodes, nodeState, setupTokens } from '@/db/schema';
import type { Result } from '@/lib/accounts';
import { needsAgreement } from '@/lib/agreement';
import { writeAudit } from '@/lib/audit';
import { askReported, askWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { nodeRetireMail } from '@/lib/mail-templates';
import { duration } from '@/lib/noc/format';
import { hit } from '@/lib/ratelimit';
import type { RequestMeta } from '@/lib/sessions';
import { adminContacts, getUser } from '@/lib/users';
import { firstError } from '@/lib/validation';
import { anchorMhz } from './radio-plan';
import { currentRelease } from './release';
import { messageSchema, NOT_ON_THIS_SITE, plain } from './requests';
import { renderSetupScript } from './setup';
import { makeSetupToken, newKeyCommand, type Node, setupCommand } from './setup-tokens';

// My nodes (portal spec §6.3). Everything here starts from the account's own
// nodes: anyone else's is "no such node", never a hint that it exists. The
// cores' answers are shared: one cell.status and cell.radio per core at most
// every 15 s, as actor 0, by every page and the watcher together.

const NO_NODE = 'You have no such node.';
const READ_MS = 3000;
export const SNAPSHOT_MS = 15_000;
const MAX_FUTURE_WINDOWS = 5;
const MAX_WINDOW_MS = 30 * 86_400_000;
const PAST_GRACE_MS = 5 * 60_000;

export interface CellSnapshot {
  cells: Map<number, CellStatus>;
  radios: Map<number, RadioStatus[]>;
  at: number;
}

interface SnapshotEntry {
  value: CellSnapshot | null;
  at: number;
  asking: Promise<CellSnapshot | null> | null;
}

// One per process, as __ocCores is: Next can load this module more than once.
// Keyed by the cores array, so a test's own set of cores starts empty.
const g = globalThis as typeof globalThis & { __ocCellSnap?: WeakMap<object, Map<string, SnapshotEntry>> };

function entryOf(ctx: Ctx, coreId: string): SnapshotEntry {
  g.__ocCellSnap ??= new WeakMap();
  let byCore = g.__ocCellSnap.get(ctx.cores);
  if (!byCore) {
    byCore = new Map();
    g.__ocCellSnap.set(ctx.cores, byCore);
  }
  let e = byCore.get(coreId);
  if (!e) {
    e = { value: null, at: Number.NEGATIVE_INFINITY, asking: null };
    byCore.set(coreId, e);
  }
  return e;
}

async function ask(ctx: Ctx, coreId: string): Promise<CellSnapshot | null> {
  const h = ctx.cores.find((c) => c.id === coreId);
  if (!h) return null;
  const [cells, radios] = await Promise.all([
    askWithin(h, 'cell.status', () => h.core.cellStatus(0), READ_MS),
    // An older core has no cell.radio: its nodes just show no radio details.
    askReported(h, 'cell.radio', () => h.core.cellRadio(0), READ_MS),
  ]);
  if (cells === null) return null;
  const byCell = new Map<number, RadioStatus[]>();
  if (radios.state === 'ok') {
    for (const r of radios.value) byCell.set(r.cellId, [...(byCell.get(r.cellId) ?? []), r]);
  }
  return { cells: new Map(cells.map((c) => [c.cellId, c])), radios: byCell, at: ctx.now() };
}

/** A core's cells and radios, at most 15 s old; null when it did not answer (also kept 15 s). `fresh`: ask now (the watcher). */
export function cellSnapshot(ctx: Ctx, coreId: string, o: { fresh?: boolean } = {}): Promise<CellSnapshot | null> {
  const e = entryOf(ctx, coreId);
  if (e.asking) return e.asking;
  if (!o.fresh && ctx.now() - e.at < SNAPSHOT_MS) return Promise.resolve(e.value);
  e.asking = ask(ctx, coreId)
    .then((value) => {
      e.value = value;
      e.at = ctx.now();
      return value;
    })
    .finally(() => {
      e.asking = null;
    });
  return e.asking;
}

/** Drop what is kept, so the next look asks (the fake core's simulation; tests). */
export function forgetSnapshot(ctx: Ctx, coreId?: string): void {
  const byCore = g.__ocCellSnap?.get(ctx.cores);
  if (coreId === undefined) byCore?.clear();
  else byCore?.delete(coreId);
}

export interface DowntimeWindow {
  id: number;
  startsAt: number;
  endsAt: number;
  reason: string;
}

export interface NodeCard {
  id: number;
  siteName: string;
  cellId: number;
  coreId: string;
  state: 'waiting_setup' | 'online' | 'offline' | 'unknown' | 'revoked';
  onlineSince: number | null;
  offlineSince: number | null;
  lastHeardAt: number | null;
  boardUptimeS: number | null;
  terminals: number | null;
  calls: number | null;
  channel: { anchor: number; mhz: number; reported: boolean };
  mode: CellMode;
  cert: { fpr: string; expiresAt: number } | null;
  setup: { expiresAt: number } | null;
  alertsMuted: boolean;
  downtime: DowntimeWindow[];
  agreementBehind: boolean;
}

export function downtimeOf(ctx: Ctx, nodeId: number): DowntimeWindow[] {
  return ctx.db
    .select({ id: nodeDowntime.id, startsAt: nodeDowntime.startsAt, endsAt: nodeDowntime.endsAt, reason: nodeDowntime.reason })
    .from(nodeDowntime)
    .where(and(eq(nodeDowntime.nodeId, nodeId), isNull(nodeDowntime.cancelledAt), gt(nodeDowntime.endsAt, ctx.now())))
    .orderBy(asc(nodeDowntime.startsAt))
    .all();
}

function cardOf(ctx: Ctx, n: Node, snap: CellSnapshot | null): NodeCard {
  const s = ctx.db.select().from(nodeState).where(eq(nodeState.nodeId, n.id)).get();
  const cell = snap?.cells.get(n.cellId);
  const radio = snap?.radios.get(n.cellId)?.[0];
  const setup = ctx.db
    .select({ expiresAt: setupTokens.expiresAt })
    .from(setupTokens)
    .where(and(eq(setupTokens.nodeId, n.id), isNull(setupTokens.usedAt), gt(setupTokens.expiresAt, ctx.now())))
    .orderBy(desc(setupTokens.expiresAt))
    .get();
  let state: NodeCard['state'];
  if (n.revokedAt !== null || cell?.revoked) state = 'revoked';
  else if (n.certFpr === null) state = 'waiting_setup';
  else if (!cell) state = 'unknown';
  else if (cell.online) state = 'online';
  else state = cell.lastHeardAt === null ? 'waiting_setup' : 'offline';
  const anchor = radio?.anchor ?? n.anchor;
  return {
    id: n.id,
    siteName: n.siteName,
    cellId: n.cellId,
    coreId: n.coreId,
    state,
    onlineSince: state === 'online' ? (s?.onlineSince ?? null) : null,
    offlineSince: state === 'offline' ? (s?.offlineSince ?? null) : null,
    lastHeardAt: cell?.lastHeardAt ?? s?.lastHeardAt ?? null,
    boardUptimeS: radio?.boardUptimeS ?? null,
    terminals: cell?.terminals ?? null,
    calls: cell?.calls ?? null,
    channel: { anchor, mhz: anchorMhz(anchor), reported: radio !== undefined },
    mode: cell?.mode ?? n.mode,
    cert: n.certFpr !== null && n.certExpiresAt !== null ? { fpr: n.certFpr, expiresAt: n.certExpiresAt } : null,
    setup: setup ?? null,
    alertsMuted: n.alertsMuted,
    downtime: downtimeOf(ctx, n.id),
    agreementBehind: n.userId !== null && needsAgreement(ctx, n.userId),
  };
}

/** The account's own nodes as cards, each asked of its own core. */
export async function myNodes(ctx: Ctx, userId: number): Promise<NodeCard[]> {
  const rows = ctx.db.select().from(nodes).where(eq(nodes.userId, userId)).orderBy(asc(nodes.id)).all();
  const coreIds = [...new Set(rows.filter((n) => n.revokedAt === null).map((n) => n.coreId))];
  const snaps = new Map(await Promise.all(coreIds.map(async (id) => [id, await cellSnapshot(ctx, id)] as const)));
  return rows.map((n) => cardOf(ctx, n, snaps.get(n.coreId) ?? null));
}

/** The account's own node row, with its exact pin (its operator may see it), or null. */
export function myNodeRow(ctx: Ctx, userId: number, id: number): Node | null {
  return ctx.db.select().from(nodes).where(and(eq(nodes.id, id), eq(nodes.userId, userId))).get() ?? null;
}

export async function getMyNode(ctx: Ctx, userId: number, id: number): Promise<NodeCard | null> {
  const n = myNodeRow(ctx, userId, id);
  if (!n) return null;
  return cardOf(ctx, n, n.revokedAt === null ? await cellSnapshot(ctx, n.coreId) : null);
}

const coreName = (id: string) => id.replace(/^core(\d+)$/, 'core $1');
const hhmm = (t: number) => `${new Date(t).toISOString().slice(11, 16)} UTC`;

/** The card's one line of state, and its tone. */
export function cardLine(c: NodeCard, now: number): { label: string; tone: 'ok' | 'warn' | 'off' | 'wait' } {
  switch (c.state) {
    case 'revoked':
      return { label: 'Revoked', tone: 'off' };
    case 'waiting_setup':
      return { label: c.cert ? 'Waiting for the node' : 'Waiting for setup', tone: 'wait' };
    case 'unknown':
      return { label: `Status unknown (${coreName(c.coreId)} didn't answer)`, tone: 'warn' };
    case 'online': {
      const up = c.onlineSince !== null ? (now - c.onlineSince) / 1000 : c.boardUptimeS;
      return { label: up === null ? 'Online' : `Online · up ${duration(up)}`, tone: 'ok' };
    }
    case 'offline': {
      const window = c.downtime.find((w) => w.startsAt <= now && now < w.endsAt);
      if (window) return { label: `In downtime until ${hhmm(window.endsAt)}`, tone: 'wait' };
      const since = c.offlineSince ?? c.lastHeardAt;
      return { label: since === null ? 'Offline' : `Offline for ${duration((now - since) / 1000)}`, tone: 'off' };
    }
  }
}

/** A setup command for the account's own unrevoked node: shown once, on the page after the action; the one before stops working. */
export function newSetupCommand(ctx: Ctx, userId: number, nodeId: number, meta: RequestMeta): Result<{ command: string; newKeyCommand: string; expiresAt: number; script: string; inspect: string }> {
  if (ctx.config.site !== 'portal') return { ok: false, error: NOT_ON_THIS_SITE };
  const n = myNodeRow(ctx, userId, nodeId);
  if (!n) return { ok: false, error: NO_NODE };
  if (n.revokedAt !== null) return { ok: false, error: 'This node has been revoked.' };
  const rel = currentRelease(ctx);
  if (!rel) return { ok: false, error: 'Setup opens when the cell software is published. Please try again later.' };
  const { token, expiresAt } = makeSetupToken(ctx, nodeId, userId);
  writeAudit(ctx, { actorId: userId, action: 'node.setup_command', target: `node:${nodeId}`, ip: meta.ip });
  return { ok: true, command: setupCommand(ctx, token), newKeyCommand: newKeyCommand(ctx, token), expiresAt, script: renderSetupScript(ctx, token, rel), inspect: `${ctx.config.origin}/setup/${token}` };
}

export function setAlertsMuted(ctx: Ctx, userId: number, nodeId: number, muted: boolean, meta: RequestMeta): Result {
  if (!myNodeRow(ctx, userId, nodeId)) return { ok: false, error: NO_NODE };
  ctx.db.update(nodes).set({ alertsMuted: muted }).where(eq(nodes.id, nodeId)).run();
  writeAudit(ctx, { actorId: userId, action: 'node.alerts', target: `node:${nodeId}`, detail: { muted }, ip: meta.ip });
  return { ok: true };
}

const time = z.coerce.number('Please pick a time.').int('Please pick a time.').positive('Please pick a time.').max(8_640_000_000_000_000, 'Please pick a time.');
const downtimeSchema = z.object({ startsAt: time, endsAt: time, reason: plain(3, 200, 'reason') });

/** A planned window (spec §6.3): alerts pause, and admins see it. */
export function addDowntime(ctx: Ctx, userId: number, nodeId: number, input: unknown, meta: RequestMeta): Result {
  if (!myNodeRow(ctx, userId, nodeId)) return { ok: false, error: NO_NODE };
  const p = downtimeSchema.safeParse(input);
  if (!p.success) return { ok: false, error: firstError(p.error) };
  const { startsAt, endsAt, reason } = p.data;
  const now = ctx.now();
  if (startsAt < now - PAST_GRACE_MS) return { ok: false, error: 'That window has already begun.' };
  if (endsAt <= startsAt) return { ok: false, error: 'The end must come after the start.' };
  if (endsAt - startsAt > MAX_WINDOW_MS) return { ok: false, error: 'A window is at most 30 days.' };
  if (downtimeOf(ctx, nodeId).length >= MAX_FUTURE_WINDOWS) return { ok: false, error: `A node can have at most ${MAX_FUTURE_WINDOWS} windows ahead.` };
  const id = ctx.db.insert(nodeDowntime).values({ nodeId, startsAt, endsAt, reason, createdBy: userId, createdAt: now }).returning({ id: nodeDowntime.id }).get().id;
  writeAudit(ctx, { actorId: userId, action: 'node.downtime', target: `node:${nodeId}`, detail: { id, startsAt, endsAt }, ip: meta.ip });
  return { ok: true };
}

export function cancelDowntime(ctx: Ctx, userId: number, downtimeId: number, meta: RequestMeta): Result {
  const row = ctx.db.select().from(nodeDowntime).where(eq(nodeDowntime.id, downtimeId)).get();
  if (!row || !myNodeRow(ctx, userId, row.nodeId)) return { ok: false, error: 'You have no such notice.' };
  const done = ctx.db.update(nodeDowntime).set({ cancelledAt: ctx.now() }).where(and(eq(nodeDowntime.id, downtimeId), isNull(nodeDowntime.cancelledAt))).run();
  if (done.changes !== 1) return { ok: false, error: 'You have no such notice.' };
  writeAudit(ctx, { actorId: userId, action: 'node.downtime_cancel', target: `node:${row.nodeId}`, detail: { id: downtimeId }, ip: meta.ip });
  return { ok: true };
}

/** "Tell the admins I'm retiring this node" (decision 24): a message; an admin revokes the cell. */
export function askRetire(ctx: Ctx, userId: number, nodeId: number, note: unknown, meta: RequestMeta): Result {
  const n = myNodeRow(ctx, userId, nodeId);
  if (!n) return { ok: false, error: NO_NODE };
  const p = messageSchema.safeParse(note);
  if (!p.success) return { ok: false, error: firstError(p.error) };
  const lim = hit(ctx, 'node_message', String(userId));
  if (!lim.ok) return { ok: false, error: lim.message };
  const u = getUser(ctx, userId);
  writeAudit(ctx, { actorId: userId, action: 'node.retire_ask', target: `node:${nodeId}`, ip: meta.ip });
  for (const a of adminContacts(ctx)) {
    const m = nodeRetireMail(a.name, `${u?.name} (${u?.email})`, nodeId, n.siteName, p.data, `${ctx.config.origin}/admin/cells`, ctx.config.origin);
    ctx.mailQueue.send({ to: a.email, subject: m.subject, text: m.text });
  }
  return { ok: true };
}
