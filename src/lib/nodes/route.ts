import type { CoreHandle } from '@/core/types';
import type { Ctx } from '@/lib/ctx';
import { UserError } from '@/lib/errors';
import { type Side, sideOfRegion } from '@/lib/numbers/homing';

/**
 * The core a new cell goes on (plan P3, decision 7): the core of its state's
 * side (portal spec §4.3), East on core 1 and West on core 2. `preferred`, the
 * admin's pick, wins if it has a cell address. A side whose core has no cell
 * address falls back to the first core that does, and `note` says so for the
 * review. Only a core with a cell address can take one: its address goes into
 * the cell's config.
 */
export function cellCoreFor(ctx: Ctx, region: string, preferred?: string): { handle: CoreHandle; side: Side | null; note: string | null } {
  const side = sideOfRegion(region);
  const picked = preferred === undefined ? undefined : ctx.cores.find((h) => h.id === preferred && h.cellAddr);
  if (picked) return { handle: picked, side, note: null };
  const wanted = side === null ? null : side === 'east' ? 1 : 2;
  const own = ctx.cores.find((h) => h.coreNo === wanted);
  if (own?.cellAddr) return { handle: own, side, note: null };
  const first = ctx.cores.find((h) => h.cellAddr);
  if (!first) throw new UserError('No core takes cells');
  if (ctx.cores.length === 1) return { handle: first, side, note: null };
  return {
    handle: first,
    side,
    note: wanted === null ? `No core is known for ${region}; this goes to ${first.id}.` : `It belongs on core ${wanted}, which takes no cells yet; this goes to ${first.id}.`,
  };
}
