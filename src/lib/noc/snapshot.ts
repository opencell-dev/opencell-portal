import { type CellStatus, type CoreBlock, type CoreHandle, type CoreStatus, isCoreError, type OcssPeer, type RadioStatus } from '@/core/types';
import { askReported, askWithin, type Reported } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { radioView } from './radio';

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
  /** Plan N2a (core v0.4.0): every linked cell's radios (cell.radio 0). Absent: not asked. */
  radio?: Reported<RadioStatus[]>;
  /** The core's OCSS peers (ocss.status). */
  ocss?: Reported<OcssPeer[]>;
  /** The core's blocks (core.blocks), asked at most every BLOCKS_TTL_MS. */
  blocks?: Reported<CoreBlock[]>;
}

/** core.blocks changes only when a core restarts with a new config, and its rate is 120 an hour: asked this often at most. */
export const BLOCKS_TTL_MS = 10 * 60_000;
/** An older core that answered 'unsupported' is not asked that again for this long (its "unknown op" rate is 60 an hour). */
export const UNSUPPORTED_RETRY_MS = 10 * 60_000;
/** Review I4(b): a rate-limited op is not asked again for this long either, so the shared bucket it drained gets a chance to refill. */
export const RATE_LIMIT_BACKOFF_MS = 3 * 60_000;

interface Memo {
  state: 'unsupported' | 'unreachable';
  until: number;
}

const memoOf = new WeakMap<CoreHandle, Map<string, Memo>>();

function memo(h: CoreHandle): Map<string, Memo> {
  let m = memoOf.get(h);
  if (!m) {
    m = new Map();
    memoOf.set(h, m);
  }
  return m;
}

/**
 * askReported, but an operation the core said it lacks is not asked again
 * for UNSUPPORTED_RETRY_MS, and one it rate-limited is not asked again for
 * RATE_LIMIT_BACKOFF_MS (per core handle and `what`; review I4). Shared by
 * the snapshot's own polls and, so an older or rate-limited core is not
 * asked twice for the same reason, by every per-viewer read of the same op
 * (registrations.ts, calls.ts, core-audit.ts).
 */
export async function askNoc<T>(h: CoreHandle, what: string, ask: () => Promise<T>, deadlineMs: number, now: number): Promise<Reported<T>> {
  const m = memo(h);
  const hit = m.get(what);
  if (hit && hit.until > now) return { state: hit.state };
  let code: string | undefined;
  const r = await askReported(h, what, ask, deadlineMs, (e) => {
    code = isCoreError(e) ? e.code : undefined;
  });
  if (r.state === 'unsupported') m.set(what, { state: 'unsupported', until: now + UNSUPPORTED_RETRY_MS });
  else if (r.state === 'unreachable' && code === 'rate_limited') m.set(what, { state: 'unreachable', until: now + RATE_LIMIT_BACKOFF_MS });
  else m.delete(what);
  return r;
}

/** Whether `what` on `h` is remembered right now as unsupported (an older core), without asking it (review I4a/I4c). */
export function isUnsupported(h: CoreHandle, what: string, now: number): boolean {
  const hit = memo(h).get(what);
  return !!hit && hit.state === 'unsupported' && hit.until > now;
}

const blocksCache = new WeakMap<CoreHandle, { at: number; blocks: Reported<CoreBlock[]> }>();

async function blocksOf(h: CoreHandle, deadlineMs: number, now: number): Promise<Reported<CoreBlock[]>> {
  const hit = blocksCache.get(h);
  if (hit && now - hit.at < BLOCKS_TTL_MS) return hit.blocks;
  const blocks = await askNoc(h, 'blocks', () => h.core.coreBlocks(NOC_ACTOR), deadlineMs, now);
  if (blocks.state !== 'unreachable') blocksCache.set(h, { at: now, blocks });
  return blocks;
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
      const [status, cells, radio, ocss, blocks] = await Promise.all([
        askWithin(h, 'status', () => h.core.coreStatus(NOC_ACTOR), deadlineMs),
        askWithin(h, 'cells', () => h.core.cellStatus(NOC_ACTOR), deadlineMs),
        askNoc(h, 'radio', () => h.core.cellRadio(NOC_ACTOR), deadlineMs, at),
        askNoc(h, 'ocss', () => h.core.ocssStatus(NOC_ACTOR), deadlineMs, at),
        blocksOf(h, deadlineMs, at),
      ]);
      return { id: h.id, where: h.where, status, cells: cells?.slice().sort((a, b) => a.cellId - b.cellId) ?? null, radio, ocss, blocks };
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
  /** Review M5: true when at least one core's cell list did not come, so cellsEnabled/cellsOnline are incomplete, not "all accounted for". */
  cellsUnknown: boolean;
  /** Most severe first. */
  attention: Attention[];
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** What a linked cell's radio report says needs attention (plan N2a): no report, a stale one, a silent board, PPS or time lost, radio errors. */
function radioAttention(out: Attention[], core: string, cell: CellStatus, radios: RadioStatus[], now: number): void {
  const who = `Cell ${cell.cellId} "${cell.name}" on ${core}`;
  const mine = radios.filter((r) => r.cellId === cell.cellId);
  if (mine.length === 0) {
    out.push({ severity: 'info', core, cellId: cell.cellId, text: `${who} has not reported its radio (oc-cell before v0.1.2, or just linked)` });
    return;
  }
  for (const r of mine) {
    const v = radioView(r, now);
    const radio = mine.length > 1 ? ` radio ${r.radio}` : '';
    if (v.stale) {
      out.push({ severity: 'warning', core, cellId: cell.cellId, text: `${who}${radio}: last radio report ${minutes(v.ageMs)} ago; PPS and time unknown` });
      continue;
    }
    if (v.boardSilent) {
      out.push({ severity: 'warning', core, cellId: cell.cellId, text: `${who}${radio}: the board is not answering the cell` });
      continue;
    }
    if (v.pps !== 'locked') out.push({ severity: 'warning', core, cellId: cell.cellId, text: `${who}${radio}: PPS ${v.pps}` });
    if (v.timebase === false) out.push({ severity: 'warning', core, cellId: cell.cellId, text: `${who}${radio}: no timebase` });
    if (r.radioErrors > 0) {
      out.push({ severity: 'info', core, cellId: cell.cellId, text: `${who}${radio}: ${r.radioErrors} radio errors since the board started (last ${r.lastRadioError})` });
    }
  }
}

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
    cellsUnknown: false,
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
      out.cellsUnknown = true;
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
      if (cell.online && c.radio?.state === 'ok') radioAttention(out.attention, c.id, cell, c.radio.value, s.at);
    }
  }
  for (const c of s.cores) {
    if (c.ocss?.state !== 'ok') continue;
    for (const p of c.ocss.value) {
      if (p.state === 'up') continue;
      const since = p.since === null ? '' : ` for ${minutes(s.at - p.since)}`;
      out.attention.push({ severity: 'warning', core: c.id, text: `OCSS from ${c.id} to core ${p.coreId}: ${p.state}${since}` });
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
