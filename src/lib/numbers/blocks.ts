import { askWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { sideOfNpa } from './homing';

// Which core is home for which NPA (OCSS spec §5.3): core.blocks is the truth
// and either core answers it for the whole table. The answer is kept here so
// coreFor can stay synchronous; while no table is known, the state rule gives
// the same answer unless a root table moved an NPA by hand.

export interface BlockEntry {
  homeCore: number;
  index: number;
}

interface BlockCache {
  table: Map<string, BlockEntry> | null;
  /** When the table on hand was loaded. */
  at: number;
  /** When a refresh last started. */
  triedAt: number;
  refreshing: Promise<boolean> | null;
}

/** Past this age a table is refreshed behind the next answer. */
export const BLOCKS_STALE_MS = 10 * 60_000;
/** A table missing or stale is not asked for more than once in this long: core.blocks is 120/h, one bucket. */
const RETRY_MS = 60_000;
const ASK_MS = 3000;
/** An NPA's block: 8831 + the NPA. A longer prefix (the format allows one) is never made by oc-route for the portal's numbers. */
const NPA_PREFIX = /^8831([2-9]\d\d)$/;

// One per process, as __ocCores is: Next can load this module more than once.
// Keyed by the cores array, so a test's own set of cores starts with no table.
const g = globalThis as typeof globalThis & { __ocBlocks?: WeakMap<object, BlockCache> };

function cacheOf(ctx: Ctx): BlockCache {
  g.__ocBlocks ??= new WeakMap();
  let c = g.__ocBlocks.get(ctx.cores);
  if (!c) {
    c = { table: null, at: 0, triedAt: Number.NEGATIVE_INFINITY, refreshing: null };
    g.__ocBlocks.set(ctx.cores, c);
  }
  return c;
}

async function load(ctx: Ctx, c: BlockCache): Promise<boolean> {
  for (const h of ctx.cores) {
    const rows = await askWithin(h, 'core.blocks', () => h.core.coreBlocks(0), ASK_MS);
    if (rows === null || rows.length === 0) continue;
    const table = new Map<string, BlockEntry>();
    for (const b of rows) {
      const npa = NPA_PREFIX.exec(b.prefix)?.[1];
      if (npa) table.set(npa, { homeCore: b.homeCore, index: b.index });
    }
    c.table = table;
    c.at = ctx.now();
    return true;
  }
  return false;
}

/**
 * Ask each core in turn for core.blocks; the first non-empty answer replaces
 * the table. False if none answered: the table on hand stays. A refresh under
 * way is joined, not repeated. Actor 0: the portal itself.
 */
export function refreshBlocks(ctx: Ctx): Promise<boolean> {
  const c = cacheOf(ctx);
  if (c.refreshing) return c.refreshing;
  c.triedAt = ctx.now();
  c.refreshing = load(ctx, c).finally(() => {
    c.refreshing = null;
  });
  return c.refreshing;
}

/** Behind the answer: a table missing or stale is fetched for the next one. With one handle nothing asks for a table: no choice depends on it. */
function refreshIfDue(ctx: Ctx, c: BlockCache): void {
  if (ctx.cores.length < 2 || c.refreshing) return;
  const now = ctx.now();
  if (now - c.triedAt < RETRY_MS) return;
  if (c.table !== null && now - c.at < BLOCKS_STALE_MS) return;
  void refreshBlocks(ctx);
}

/** An NPA's block in the table on hand, or null: not in it, or no table yet. */
export function blockOf(ctx: Ctx, npa: string): BlockEntry | null {
  return cacheOf(ctx).table?.get(npa) ?? null;
}

/** Whether a table has been loaded: if not, a home is only the state rule's. */
export function blocksKnown(ctx: Ctx): boolean {
  return cacheOf(ctx).table !== null;
}

/**
 * The core number an NPA is homed on: the table on hand, else the state rule
 * (east → 1, west → 2), else null (not a geographic NPA the portal knows).
 * An NPA the table lacks also takes the rule: one not offered yet goes to the
 * core it will be homed on, which says it isn't assignable.
 */
export function homeCoreOf(ctx: Ctx, npa: string): number | null {
  const c = cacheOf(ctx);
  refreshIfDue(ctx, c);
  const b = c.table?.get(npa);
  if (b) return b.homeCore;
  const side = sideOfNpa(ctx, npa);
  return side === null ? null : side === 'east' ? 1 : 2;
}
