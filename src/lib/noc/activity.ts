import type { Cdr, CdrRecord, CoreHandle, LegKind } from '@/core/types';
import { cdrResult } from '@/core/wire';
import { AUDIT_REGISTER } from '@/core/wire-noc';
import type { Reported } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { askNoc, NOC_ACTOR, type NetworkSnapshot } from './snapshot';
import { Tail, type TailRow } from './tail';

// What happened on the network lately (plan N2a), from each core's call
// records (cdr.recent) and audit (audit.list), read as the portal itself
// (actor 0) at most once a minute and shared by every viewer. The shared
// rows keep no numbers: a staff member's own page reads those, under their
// own account (calls.ts, registrations.ts). Nothing is stored (ruling R1).

export const ACTIVITY_TTL_MS = 60_000;
export const DAY_MS = 86400_000;
/** The longest window the Calls page offers. */
export const CALLS_WINDOW_MS = 7 * DAY_MS;

/** A call record without its numbers. */
export type CallRow = Omit<CdrRecord, 'caller' | 'called'> & TailRow;
/** A core audit record without its number or detail: its event and cell. */
export interface AuditRow extends TailRow {
  event: number;
  cellId: number | null;
}

export const RESULTS: Cdr['result'][] = ['answered', 'no_answer', 'busy', 'unreachable', 'failed'];

export interface CallStats {
  total: number;
  answered: number;
  byResult: Record<Cdr['result'], number>;
  /** By oc_sig cause (CAUSES in core/wire-noc.ts). */
  byCause: Record<number, number>;
  /** By the called leg's kind: to a cell, the echo, the playback, a peer core. */
  byLeg: Record<LegKind, number>;
}

export function callResult(c: Pick<CdrRecord, 'answerAt' | 'cause'>): Cdr['result'] {
  return cdrResult(c.answerAt === null ? 0 : 1, c.cause);
}

/** The calls that ended in the last `windowMs` (and, with `cellId`, had a leg on that cell). */
export function callStats(rows: CallRow[], now: number, windowMs = DAY_MS, cellId?: number): CallStats {
  const out: CallStats = {
    total: 0,
    answered: 0,
    byResult: { answered: 0, no_answer: 0, busy: 0, unreachable: 0, failed: 0 },
    byCause: {},
    byLeg: { cell: 0, echo: 0, playback: 0, peer: 0 },
  };
  for (const r of rows) {
    if (r.t < now - windowMs || r.t > now) continue;
    if (cellId !== undefined && r.cellA !== cellId && r.cellB !== cellId) continue;
    out.total++;
    const res = callResult(r);
    out.byResult[res]++;
    if (res === 'answered') out.answered++;
    out.byCause[r.cause] = (out.byCause[r.cause] ?? 0) + 1;
    out.byLeg[r.legB]++;
  }
  return out;
}

export interface CoreActivity {
  id: string;
  calls: Reported<CallStats> & { complete?: boolean };
  /** REGISTER records in the last day, in all and by cell. */
  registrations: Reported<{ total: number; byCell: Record<number, number> }> & { complete?: boolean };
}

export interface Activity {
  at: number;
  cores: CoreActivity[];
}

interface CoreTails {
  calls: Tail<CallRow>;
  /**
   * The core's audit: its cursor is where the audit ends (the core page reads
   * the newest records from there); of the last day it keeps only REGISTER.
   * Up to 8 pages of 500 a minute: audit.list's burst is 30 (a first seek
   * takes about 2 log2(records / 500) of them).
   */
  audit: Tail<AuditRow>;
}

const tails = new WeakMap<Ctx, Map<string, CoreTails>>();

function tailsOf(ctx: Ctx, id: string): CoreTails {
  const all = tails.get(ctx) ?? new Map<string, CoreTails>();
  tails.set(ctx, all);
  let t = all.get(id);
  if (!t) {
    t = {
      calls: new Tail<CallRow>(CALLS_WINDOW_MS, 1000),
      audit: new Tail<AuditRow>(DAY_MS, 500, 8, (r) => r.event === AUDIT_REGISTER),
    };
    all.set(id, t);
  }
  return t;
}

const noNumbers = ({ caller: _a, called: _b, ...rest }: CdrRecord): CallRow => ({ ...rest, t: rest.endAt });

async function refreshCore(ctx: Ctx, h: CoreHandle, epoch: number, at: number, deadlineMs: number): Promise<CoreActivity> {
  const t = tailsOf(ctx, h.id);
  const [calls, audit] = await Promise.all([
    askNoc(
      h,
      'cdr.recent',
      () => t.calls.refresh(async (after, limit) => (await h.core.cdrRecent(NOC_ACTOR, after, limit)).map(noNumbers), at, epoch),
      deadlineMs,
      at,
    ),
    askNoc(
      h,
      'audit.list',
      () =>
        t.audit.refresh(
          async (after, limit) => (await h.core.auditList(NOC_ACTOR, { after, limit })).map((r) => ({ id: r.id, t: r.at, event: r.event, cellId: r.cellId })),
          at,
          epoch,
        ),
      deadlineMs,
      at,
    ),
  ]);
  const byCell: Record<number, number> = {};
  for (const r of t.audit.rows) if (r.cellId !== null) byCell[r.cellId] = (byCell[r.cellId] ?? 0) + 1;
  return {
    id: h.id,
    calls: calls.state === 'ok' ? { state: 'ok', value: callStats(t.calls.rows, at), complete: t.calls.complete } : calls,
    registrations: audit.state === 'ok' ? { state: 'ok', value: { total: t.audit.rows.length, byCell }, complete: t.audit.complete } : audit,
  };
}

/**
 * Each answering core's activity: its tails brought up to date (as actor 0),
 * each within the deadline. A core the snapshot found unreachable is not
 * asked. The core's start time (from its uptime) is the tails' epoch.
 */
export async function networkActivity(ctx: Ctx, snap: NetworkSnapshot, deadlineMs = 3000): Promise<Activity> {
  const at = ctx.now();
  const cores = await Promise.all(
    ctx.cores.map(async (h): Promise<CoreActivity> => {
      const st = snap.cores.find((c) => c.id === h.id)?.status;
      if (!st) return { id: h.id, calls: { state: 'unreachable' }, registrations: { state: 'unreachable' } };
      // Review I3: kept as raw ms (not rounded to the minute); Tail compares it with a tolerance.
      const epoch = snap.at - st.uptimeS * 1000;
      return refreshCore(ctx, h, epoch, at, deadlineMs);
    }),
  );
  return { at, cores };
}

const cache = new WeakMap<Ctx, { at: number; activity: Promise<Activity> }>();

/** The activity shared by every NOC page and viewer for ttlMs. */
export function cachedActivity(ctx: Ctx, snap: NetworkSnapshot, ttlMs = ACTIVITY_TTL_MS, deadlineMs = 3000): Promise<Activity> {
  const hit = cache.get(ctx);
  if (hit && ctx.now() - hit.at < ttlMs) return hit.activity;
  const activity = networkActivity(ctx, snap, deadlineMs);
  cache.set(ctx, { at: ctx.now(), activity });
  return activity;
}

/** After the demo network is reloaded: every tail and the cache start again. */
export function forgetActivity(ctx: Ctx): void {
  cache.delete(ctx);
  tails.delete(ctx);
}

/** Where core `id`'s call records from time t on start (an `after` for cdr.recent), from the shared tail; null: not known yet. */
export function callsAfter(ctx: Ctx, id: string, t: number): number | null {
  return tails.get(ctx)?.get(id)?.calls.afterFor(t) ?? null;
}

/** The newest id of core `id`'s audit the shared tail has seen; null: not known yet. */
export function auditEnd(ctx: Ctx, id: string): number | null {
  return tails.get(ctx)?.get(id)?.audit.after ?? null;
}

/** Whether core `id`'s audit tail has read every record of the window yet; false while it is still working through a backlog (review M2). */
export function auditComplete(ctx: Ctx, id: string): boolean {
  return tails.get(ctx)?.get(id)?.audit.complete ?? false;
}

/** Core `id`'s calls (no numbers) of the shared tail's window; null: not read yet. */
export function callRows(ctx: Ctx, id: string): CallRow[] | null {
  const t = tails.get(ctx)?.get(id)?.calls;
  return t && t.after !== null ? t.rows : null;
}

export interface ActivitySummary {
  /** The calls of the last day on the cores that reported them; null: none did. */
  calls: CallStats | null;
  /** The last day's registrations on the cores that reported them; null: none did. */
  registrations: number | null;
  /** Cores that did not report (unreachable, or before v0.4.0): the totals leave them out. */
  missing: string[];
  /** A core is still reading its backlog (Tail.complete false): the totals are low for now. */
  catchingUp: boolean;
}

/** The overview's totals over every core that reported. */
export function summarizeActivity(a: Activity): ActivitySummary {
  const out: ActivitySummary = { calls: null, registrations: null, missing: [], catchingUp: false };
  for (const c of a.cores) {
    if (c.calls.state === 'ok') {
      const s = c.calls.value;
      const t = (out.calls ??= callStats([], 0));
      t.total += s.total;
      t.answered += s.answered;
      for (const k of RESULTS) t.byResult[k] += s.byResult[k];
      for (const [k, v] of Object.entries(s.byCause)) t.byCause[Number(k)] = (t.byCause[Number(k)] ?? 0) + v;
      for (const k of ['cell', 'echo', 'playback', 'peer'] as const) t.byLeg[k] += s.byLeg[k];
      if (c.calls.complete === false) out.catchingUp = true;
    }
    if (c.registrations.state === 'ok') {
      out.registrations = (out.registrations ?? 0) + c.registrations.value.total;
      if (c.registrations.complete === false) out.catchingUp = true;
    }
    if (c.calls.state !== 'ok' || c.registrations.state !== 'ok') out.missing.push(c.id);
  }
  return out;
}
