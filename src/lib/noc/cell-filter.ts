import { z } from 'zod';
import type { CellRow } from './snapshot';

// The cell list's filters live in the URL (NOC design §9: URL state), so a
// filtered view can be linked and survives a refresh. Anything that does not
// parse is ignored, never an error page.

export const CELL_STATES = ['online', 'offline', 'never', 'revoked'] as const;
export type CellState = (typeof CELL_STATES)[number];

const filterSchema = z.object({
  core: z.string().regex(/^[a-z][a-z0-9]{0,15}$/).optional().catch(undefined),
  state: z.enum(CELL_STATES).optional().catch(undefined),
  mode: z.enum(['part15', 'part97']).optional().catch(undefined),
  q: z.string().trim().max(32).optional().catch(undefined),
});

export type CellFilter = z.infer<typeof filterSchema>;

/** The filter from searchParams (a repeated key counts once: its first value). */
export function parseCellFilter(sp: Record<string, string | string[] | undefined>): CellFilter {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  return filterSchema.parse({ core: one(sp.core), state: one(sp.state), mode: one(sp.mode), q: one(sp.q) });
}

export function cellState(c: CellRow): CellState {
  if (c.revoked) return 'revoked';
  if (c.online) return 'online';
  return c.lastHeardAt === null ? 'never' : 'offline';
}

export function filterCells(cells: CellRow[], f: CellFilter): CellRow[] {
  const q = f.q?.toLowerCase();
  return cells.filter(
    (c) =>
      (!f.core || c.core === f.core) &&
      (!f.state || cellState(c) === f.state) &&
      (!f.mode || c.mode === f.mode) &&
      (!q || c.name.toLowerCase().includes(q) || String(c.cellId) === q),
  );
}
