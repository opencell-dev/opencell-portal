import type { CellStatus, CoreStatus } from '@/core/types';
import { askWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';

// The NOC's view of the network right now (NOC design §5, plan N1): every
// core's core.status and cell.status, asked at once, each within the
// deadline. Nothing is stored: N1 is read-only and stateless (ruling R1).

/** The portal itself, as the actor of the NOC's shared status polls (NOC design §8). */
export const NOC_ACTOR = 0;
/**
 * P4 rule (the P3 alert rule, portal spec §6.3): a cell offline this long
 * needs attention. Not used to grade a cell's severity in `summarize`
 * (review I2): a real core's `lastHeardAt` is the time of the cell's last
 * HELLO (network-core `on_hello`), not its last traffic, so the gap since
 * it cannot be trusted to time how long a cell has actually been offline.
 * Kept for a future duration-based rule once the core reports a reliable
 * last-traffic time (core telemetry plan).
 */
export const OFFLINE_ALERT_MS = 10 * 60_000;

export interface CoreView {
  /** The config id (core1, core2; fake, fake2 for the fake cores). */
  id: string;
  where: string;
  /** null: no answer within the deadline (Unreachable). */
  status: CoreStatus | null;
  /** null: the cell list did not come within the deadline. */
  cells: CellStatus[] | null;
}

export interface NetworkSnapshot {
  /** When the cores were asked (unix ms). */
  at: number;
  deadlineMs: number;
  cores: CoreView[];
}

/** Every core's status and cells, in config order; a core that is down or slow holds this up by deadlineMs at most. */
export async function networkSnapshot(ctx: Ctx, deadlineMs = 3000): Promise<NetworkSnapshot> {
  const at = ctx.now();
  const cores = await Promise.all(
    ctx.cores.map(async (h): Promise<CoreView> => {
      const [status, cells] = await Promise.all([
        askWithin(h, 'status', () => h.core.coreStatus(NOC_ACTOR), deadlineMs),
        askWithin(h, 'cells', () => h.core.cellStatus(NOC_ACTOR), deadlineMs),
      ]);
      return { id: h.id, where: h.where, status, cells: cells?.slice().sort((a, b) => a.cellId - b.cellId) ?? null };
    }),
  );
  return { at, deadlineMs, cores };
}

const cache = new WeakMap<Ctx, { at: number; snap: Promise<NetworkSnapshot> }>();

/**
 * The snapshot shared by every NOC page and viewer for ttlMs (NOC design
 * §8): N viewers refreshing every 30 s cost each core two calls per ttlMs,
 * not 2N per 30 s, within the core's per-operation rate (cell.status and
 * core.status: 1200 an hour, burst 60).
 */
export function cachedSnapshot(ctx: Ctx, ttlMs = 10_000, deadlineMs = 3000): Promise<NetworkSnapshot> {
  const hit = cache.get(ctx);
  if (hit && ctx.now() - hit.at < ttlMs) return hit.snap;
  const snap = networkSnapshot(ctx, deadlineMs);
  cache.set(ctx, { at: ctx.now(), snap });
  return snap;
}

/** The next cachedSnapshot asks the cores again (after a demo control changed what they say). */
export function forgetSnapshot(ctx: Ctx): void {
  cache.delete(ctx);
}

export type Severity = 'critical' | 'warning' | 'info';

export interface Attention {
  severity: Severity;
  /** The core's config id, and the cell when it is about one. */
  core: string;
  cellId?: number;
  text: string;
}

export interface NetworkSummary {
  coresUp: number;
  coresTotal: number;
  /** Cells not revoked, on the cores that answered. */
  cellsEnabled: number;
  cellsOnline: number;
  cellsRevoked: number;
  /** Terminals registered (cell.status), on the cores that answered. */
  terminals: number;
  /** Calls in progress (core.status). */
  calls: number;
  /** Activated subscribers (core.status). */
  subscribers: number;
  /** Most severe first. */
  attention: Attention[];
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? 'under a minute' : m === 1 ? '1 min' : `${m} min`;
}

/** The overview's totals and its "needs attention" list, from what the cores said. */
export function summarize(s: NetworkSnapshot): NetworkSummary {
  const out: NetworkSummary = {
    coresUp: 0,
    coresTotal: s.cores.length,
    cellsEnabled: 0,
    cellsOnline: 0,
    cellsRevoked: 0,
    terminals: 0,
    calls: 0,
    subscribers: 0,
    attention: [],
  };
  for (const c of s.cores) {
    if (!c.status) {
      out.attention.push({ severity: 'critical', core: c.id, text: `${c.id} did not answer within ${s.deadlineMs / 1000} s` });
    } else {
      out.coresUp++;
      out.calls += c.status.callsNow;
      out.subscribers += c.status.subscribers;
    }
    if (!c.cells) {
      if (c.status) out.attention.push({ severity: 'warning', core: c.id, text: `${c.id}'s cell list did not come within ${s.deadlineMs / 1000} s` });
      continue;
    }
    for (const cell of c.cells) {
      if (cell.revoked) {
        out.cellsRevoked++;
        continue;
      }
      out.cellsEnabled++;
      out.terminals += cell.terminals;
      const who = `Cell ${cell.cellId} "${cell.name}" on ${c.id}`;
      if (cell.online) {
        out.cellsOnline++;
      } else if (cell.lastHeardAt === null) {
        out.attention.push({ severity: 'info', core: c.id, cellId: cell.cellId, text: `${who} has never connected` });
      } else {
        // Review I2: lastHeardAt is the last HELLO, not the last traffic, so
        // the gap since it cannot time how long the cell has been offline
        // (a cell can look "just went offline" when it in fact dropped much
        // earlier, or vice versa). Any offline, previously-connected cell is
        // a warning regardless of that gap; the time is shown as what it is.
        out.attention.push({
          severity: 'warning',
          core: c.id,
          cellId: cell.cellId,
          text: `${who} offline (last HELLO ${minutes(s.at - cell.lastHeardAt)} ago)`,
        });
      }
      if (cell.certFpr === null) {
        out.attention.push({ severity: 'info', core: c.id, cellId: cell.cellId, text: `${who} has no certificate pinned` });
      }
    }
  }
  out.attention.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return out;
}

/** One cell with the core it is on, for the cell list across cores. */
export interface CellRow extends CellStatus {
  core: string;
}

/** Every cell of every core that answered, core by core in config order. */
export function allCells(s: NetworkSnapshot): CellRow[] {
  return s.cores.flatMap((c) => (c.cells ?? []).map((cell) => ({ ...cell, core: c.id })));
}
