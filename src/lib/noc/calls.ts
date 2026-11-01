import { z } from 'zod';
import type { CdrRecord, CoreHandle } from '@/core/types';
import { CDR_RECENT_MAX } from '@/core/wire-noc';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { coreActor } from '@/lib/site';
import { CALLS_WINDOW_MS, callResult, callRows, callsAfter, DAY_MS, RESULTS } from './activity';
import { askNoc, isUnsupported } from './snapshot';

// The Calls page (plan N2a): the call records of a window, read from each
// core by a staff member under their own account (cdr.recent; the core
// audits each read), starting where the shared activity says the window
// starts, and audited in the portal (noc.calls, noc.call). The filters are
// in the URL and carry no number: a number's calls are the lookup's (POST).

export const CALL_WINDOWS = { '1h': 3600_000, '24h': DAY_MS, '7d': CALLS_WINDOW_MS } as const;
export type CallWindow = keyof typeof CALL_WINDOWS;
/** At most this many rows are shown, newest first. */
export const CALLS_SHOWN = 500;
/** At most this many pages of 1000 are read from a core for one view. */
export const CALLS_PAGES = 5;
export const CALLS_DEADLINE_MS = 3000;

const filterSchema = z.object({
  core: z.string().regex(/^[a-z][a-z0-9]{0,15}$/).optional().catch(undefined),
  window: z.enum(['1h', '24h', '7d']).catch('24h'),
  result: z.enum(RESULTS as [string, ...string[]]).optional().catch(undefined),
  cell: z.coerce.number().int().min(1).max(0xffffffff).optional().catch(undefined),
  leg: z.enum(['cell', 'echo', 'playback', 'peer']).optional().catch(undefined),
});

export type CallFilter = z.infer<typeof filterSchema>;

export function parseCallFilter(sp: Record<string, string | string[] | undefined>): CallFilter {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  return filterSchema.parse({ core: one(sp.core), window: one(sp.window), result: one(sp.result), cell: one(sp.cell), leg: one(sp.leg) });
}

export type CallRecord = CdrRecord & { core: string };

export interface CoreCalls {
  id: string;
  /** 'not-ready': the shared activity has not found this core's window yet (it has not answered cdr.recent). */
  state: 'ok' | 'unsupported' | 'unreachable' | 'not-ready';
  /** More rows than CALLS_PAGES pages: the oldest of the window are left out. */
  truncated: boolean;
}

export interface CallList {
  /** Newest first, at most CALLS_SHOWN. */
  rows: CallRecord[];
  /** How many matched the filter (rows holds the newest CALLS_SHOWN). */
  matched: number;
  cores: CoreCalls[];
}

export function matches(c: CdrRecord, f: CallFilter, from: number): boolean {
  return (
    c.endAt >= from &&
    (!f.result || callResult(c) === f.result) &&
    (!f.cell || c.cellA === f.cell || c.cellB === f.cell) &&
    (!f.leg || c.legB === f.leg)
  );
}

/**
 * Review I1: a window can hold more than CALLS_PAGES pages of calls, and
 * `readCore` reads forward from `from`'s start for at most that many pages,
 * so a plain `callsAfter` can leave the window's newest calls unread. The
 * shared tail already holds every id of the window, without numbers: start
 * at the id just before the (CALLS_PAGES * limit)-th newest kept row
 * instead, so the pages that follow cover the newest calls, never the
 * oldest, whichever is less.
 */
function startAfter(ctx: Ctx, id: string, from: number): number | null {
  const after = callsAfter(ctx, id, from);
  if (after === null) return null;
  const rows = (callRows(ctx, id) ?? []).filter((r) => r.t >= from);
  const cap = CALLS_PAGES * CDR_RECENT_MAX;
  if (rows.length <= cap) return after;
  return Math.max(after, rows[rows.length - cap].id - 1);
}

async function readCore(h: CoreHandle, as: number, after: number): Promise<{ rows: CdrRecord[]; truncated: boolean }> {
  const rows: CdrRecord[] = [];
  let cursor = after;
  for (let n = 0; n < CALLS_PAGES; n++) {
    const got = await h.core.cdrRecent(as, cursor, CDR_RECENT_MAX);
    rows.push(...got);
    if (got.length < CDR_RECENT_MAX) return { rows, truncated: false };
    cursor = got[got.length - 1].id;
  }
  return { rows, truncated: true };
}

/** The calls matching `f`, from each core it names (all by default), as `userId`; audited as noc.calls. */
export async function listCalls(ctx: Ctx, f: CallFilter, userId: number, ip: string): Promise<CallList> {
  const now = ctx.now();
  const from = now - CALL_WINDOWS[f.window];
  const as = coreActor(ctx.config.site, userId);
  const handles = ctx.cores.filter((h) => !f.core || h.id === f.core);
  const per = await Promise.all(
    handles.map(async (h): Promise<{ c: CoreCalls; rows: CallRecord[] }> => {
      const after = startAfter(ctx, h.id, from);
      if (after === null) {
        // Review I4(c): the shared activity may already know this op is unsupported (an older core); say so, not "not read yet".
        const state = isUnsupported(h, 'cdr.recent', now) ? 'unsupported' : 'not-ready';
        return { c: { id: h.id, state, truncated: false }, rows: [] };
      }
      const r = await askNoc(h, 'cdr.recent', () => readCore(h, as, after), CALLS_DEADLINE_MS, now);
      if (r.state !== 'ok') return { c: { id: h.id, state: r.state, truncated: false }, rows: [] };
      return {
        c: { id: h.id, state: 'ok', truncated: r.value.truncated },
        rows: r.value.rows.filter((x) => matches(x, f, from)).map((x) => ({ ...x, core: h.id })),
      };
    }),
  );
  const all = per.flatMap((p) => p.rows).sort((a, b) => b.endAt - a.endAt || b.id - a.id);
  writeAudit(ctx, {
    actorId: userId,
    action: 'noc.calls',
    target: `core:${f.core ?? 'all'}`,
    detail: { window: f.window, result: f.result ?? null, cell: f.cell ?? null, leg: f.leg ?? null, matched: all.length },
    ip,
  });
  return { rows: all.slice(0, CALLS_SHOWN), matched: all.length, cores: per.map((p) => p.c) };
}

/** One call record by its core and id, as `userId`, audited as noc.call; null: no such record. */
export async function getCall(ctx: Ctx, core: string, id: number, userId: number, ip: string): Promise<CallRecord | null | 'unreachable' | 'unsupported'> {
  const h = ctx.cores.find((c) => c.id === core);
  if (!h) return null;
  const r = await askNoc(h, 'cdr.recent', () => h.core.cdrRecent(coreActor(ctx.config.site, userId), id - 1, 1), CALLS_DEADLINE_MS, ctx.now());
  const found = r.state === 'ok' && r.value[0]?.id === id ? { ...r.value[0], core } : null;
  writeAudit(ctx, { actorId: userId, action: 'noc.call', target: `cdr:${core}/${id}`, detail: { core, found: found !== null }, ip });
  return r.state === 'ok' ? found : r.state;
}
