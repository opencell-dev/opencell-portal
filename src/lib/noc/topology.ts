import type { CellStatus } from '@/core/types';
import type { NetworkSnapshot } from './snapshot';

// The topology's layout (NOC design §9.2), apart from its drawing so it can
// be tested: cores in a row (config order), each core's cells in rows of
// CELLS_PER_ROW beneath it, a backhaul edge from each cell to its core and
// an OCSS edge between neighbouring cores. LoRa is only the air side: no
// edge is ever drawn between two cells.

export const COL_W = 320;
export const CELLS_PER_ROW = 4;
export const CORE_Y = 50;
export const CELL_Y0 = 170;
export const ROW_H = 95;

export type NodeState = 'ok' | 'warn' | 'bad' | 'info' | 'off';

export interface CoreNode {
  id: string;
  x: number;
  y: number;
  label: string;
  sub: string;
  state: NodeState;
  href: string;
}

export interface CellNode {
  core: string;
  cellId: number;
  x: number;
  y: number;
  label: string;
  terminals: number;
  state: NodeState;
  href: string;
}

export interface Edge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: 'backhaul' | 'ocss';
  state: NodeState;
  /** For a screen reader and a tooltip. */
  title: string;
}

export interface TopologyLayout {
  width: number;
  height: number;
  cores: CoreNode[];
  cells: CellNode[];
  edges: Edge[];
}

function cellState(c: CellStatus): NodeState {
  if (c.revoked) return 'off';
  if (c.online) return 'ok';
  return c.lastHeardAt === null ? 'info' : 'warn';
}

/** Names longer than 14 characters are cut with an ellipsis, so labels never overlap. */
export function cut(s: string, n = 14): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function layoutTopology(s: NetworkSnapshot): TopologyLayout {
  const cores: CoreNode[] = [];
  const cells: CellNode[] = [];
  const edges: Edge[] = [];
  let rows = 1;
  s.cores.forEach((c, i) => {
    const cx = COL_W * i + COL_W / 2;
    cores.push({
      id: c.id,
      x: cx,
      y: CORE_Y,
      label: c.status?.name ?? c.id,
      sub: c.status ? `${c.id} · ${c.status.version}` : `${c.id} · Unreachable`,
      state: c.status ? 'ok' : 'bad',
      href: `/noc/cores/${c.id}`,
    });
    if (i > 0) {
      const prev = cores[i - 1];
      edges.push({
        x1: prev.x + 80,
        y1: CORE_Y,
        x2: cx - 80,
        y2: CORE_Y,
        kind: 'ocss',
        state: 'off',
        title: `OCSS ${prev.id} – ${c.id}: link state not reported (needs ocss.status)`,
      });
    }
    const list = c.cells ?? [];
    rows = Math.max(rows, Math.ceil(list.length / CELLS_PER_ROW));
    list.forEach((cell, k) => {
      const inRow = Math.min(CELLS_PER_ROW, list.length - Math.floor(k / CELLS_PER_ROW) * CELLS_PER_ROW);
      const col = k % CELLS_PER_ROW;
      const x = cx + (col - (inRow - 1) / 2) * (COL_W / CELLS_PER_ROW);
      const y = CELL_Y0 + Math.floor(k / CELLS_PER_ROW) * ROW_H;
      const state = cellState(cell);
      cells.push({
        core: c.id,
        cellId: cell.cellId,
        x,
        y,
        label: cut(cell.name),
        terminals: cell.revoked ? 0 : cell.terminals,
        state,
        href: `/noc/cells/${c.id}/${cell.cellId}`,
      });
      edges.push({
        x1: cx,
        y1: CORE_Y + 25,
        x2: x,
        y2: y - 18,
        kind: 'backhaul',
        state: state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : 'off',
        title: `Backhaul ${cell.name} → ${c.id}: ${state === 'ok' ? 'linked' : 'not linked'}`,
      });
    });
  });
  return { width: Math.max(COL_W, COL_W * s.cores.length), height: CELL_Y0 + rows * ROW_H, cores, cells, edges };
}
