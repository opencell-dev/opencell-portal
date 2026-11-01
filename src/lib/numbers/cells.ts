import { askWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { CORE_DEADLINE_MS } from './ownership';

// Cell names for "Registered on cell <name>" (portal spec §5), from each
// core's cell.status, kept 60 s per core (the P2 plan, Task 8) so the status
// polls do not ask the core for its cells every 5 s; a failure is kept 15 s,
// so a page does not wait on a dead core each time. A core that does not
// answer leaves the names as they were: an unknown one, the card says "cell <id>".

const TTL_MS = 60_000;
const RETRY_MS = 15_000;
interface Entry {
  until: number;
  names: Map<number, string>;
}
const g = globalThis as typeof globalThis & { __ocCellNames?: Map<string, Entry> };
const cache = (): Map<string, Entry> => (g.__ocCellNames ??= new Map());

/** The names on hand, without asking anyone. */
export function knownCellNames(coreId: string): Map<number, string> {
  return cache().get(coreId)?.names ?? new Map();
}

/**
 * cellId → name on the core with this id, waiting at most `deadlineMs`. The
 * actor is 0, the site itself (coreActor's own convention): a shared lookup,
 * not one account's, and the cache makes it nobody's in particular.
 */
export async function cellNames(ctx: Ctx, coreId: string, deadlineMs = CORE_DEADLINE_MS): Promise<Map<number, string>> {
  const hit = cache().get(coreId);
  const now = ctx.now();
  if (hit && now < hit.until) return hit.names;
  const h = ctx.cores.find((c) => c.id === coreId);
  if (!h) return new Map();
  const cells = await askWithin(h, 'cell.status', () => h.core.cellStatus(0), deadlineMs);
  if (cells === null) {
    const names = hit?.names ?? new Map<number, string>();
    cache().set(coreId, { until: now + RETRY_MS, names });
    return names;
  }
  const names = new Map(cells.map((c) => [c.cellId, c.name]));
  cache().set(coreId, { until: now + TTL_MS, names });
  return names;
}

/** Tests only. */
export function forgetCellNames(): void {
  cache().clear();
}
