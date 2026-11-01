import { askWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { CORE_DEADLINE_MS } from './ownership';

// Cell names for "Registered on cell <name>" (portal spec §5), from each
// core's cell.status, kept 60 s per core (the P2 plan, Task 8) so the status
// polls do not ask the core for its cells every 5 s. A core that does not
// answer leaves the names out: the card says "cell <id>".

const TTL_MS = 60_000;
const g = globalThis as typeof globalThis & { __ocCellNames?: Map<string, { at: number; names: Map<number, string> }> };
const cache = (): Map<string, { at: number; names: Map<number, string> }> => (g.__ocCellNames ??= new Map());

/** cellId → name on the core with this id (the portal's own name as actor: 0, it is a shared lookup). */
export async function cellNames(ctx: Ctx, coreId: string): Promise<Map<number, string>> {
  const hit = cache().get(coreId);
  const now = ctx.now();
  if (hit && now - hit.at < TTL_MS) return hit.names;
  const h = ctx.cores.find((c) => c.id === coreId);
  if (!h) return new Map();
  const cells = await askWithin(h, 'cell.status', () => h.core.cellStatus(0), CORE_DEADLINE_MS);
  if (cells === null) return hit?.names ?? new Map();
  const names = new Map(cells.map((c) => [c.cellId, c.name]));
  cache().set(coreId, { at: now, names });
  return names;
}

/** Tests only. */
export function forgetCellNames(): void {
  cache().clear();
}
