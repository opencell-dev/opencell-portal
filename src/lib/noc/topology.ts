import type { CellStatus, OcssPeer } from '@/core/types';
import type { CoreView, NetworkSnapshot } from './snapshot';

// The topology's layout (NOC design §9.2), apart from its drawing so it can
// be tested: cores in a row (config order), each core's cells in rows of
// CELLS_PER_ROW beneath it, a backhaul edge from each cell to its core and
// an OCSS edge between two cores that are peers (ocss.status, plan N2a;
// neighbours not reporting it keep N1's dashed "not reported" edge). LoRa
// is only the air side: no edge is ever drawn between two cells.

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
  /** An OCSS edge between cores that are not neighbours arcs this far above the row. */
  bend?: number;
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
      sub: c.status ? `${c.id} · ${c.status.version}${homeOf(c)}` : `${c.id} · Unreachable`,
      state: c.status ? 'ok' : 'bad',
      href: `/noc/cores/${c.id}`,
    });

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
  edges.push(...ocssEdges(s.cores, cores));
  return { width: Math.max(COL_W, COL_W * s.cores.length), height: CELL_Y0 + rows * ROW_H, cores, cells, edges };
}

/** " · +8831717" (the first block a core is home for, from core.blocks), or nothing. */
function homeOf(c: CoreView): string {
  if (c.blocks?.state !== 'ok') return '';
  const home = c.blocks.value.filter((b) => b.role === 'home');
  return home.length === 0 ? '' : ` · +${home[0].prefix}${home.length > 1 ? '…' : ''}`;
}

const OCSS_STATE: Record<OcssPeer['state'], NodeState> = { up: 'ok', open: 'warn', handshake: 'warn', connecting: 'warn', down: 'bad' };
const WORSE: NodeState[] = ['bad', 'warn', 'ok'];

/**
 * The OCSS edges: for each pair of cores, what either side's ocss.status
 * says of the other (the worse of the two). Both sides reported and neither
 * names the other: not peers, no edge. Neither reported: neighbours keep a
 * dashed grey "not reported" edge, as in N1.
 */
function ocssEdges(views: CoreView[], nodes: CoreNode[]): Edge[] {
  const out: Edge[] = [];
  const peerRow = (from: CoreView, to: CoreView): OcssPeer | null | undefined => {
    if (from.ocss?.state !== 'ok' || !to.status) return undefined; // not reported (or the other's id unknown)
    return from.ocss.value.find((p) => p.coreId === to.status?.coreId) ?? null;
  };
  for (let i = 0; i < views.length; i++) {
    for (let j = i + 1; j < views.length; j++) {
      const a = peerRow(views[i], views[j]);
      const b = peerRow(views[j], views[i]);
      const geometry = {
        x1: nodes[i].x + 80,
        y1: CORE_Y,
        x2: nodes[j].x - 80,
        y2: CORE_Y,
        kind: 'ocss' as const,
        ...(j - i > 1 ? { bend: 20 + 10 * (j - i) } : {}),
      };
      if (a === undefined && b === undefined) {
        if (j === i + 1) out.push({ ...geometry, state: 'off', title: `OCSS ${views[i].id} – ${views[j].id}: link state not reported (needs ocss.status)` });
        continue;
      }
      const rows = [a, b].filter((r): r is OcssPeer => r !== undefined && r !== null);
      if (rows.length === 0) continue; // reported, and not peers
      const state = WORSE.find((w) => rows.some((r) => OCSS_STATE[r.state] === w)) ?? 'ok';
      const dialer = a?.dials ? views[i].id : views[j].id;
      out.push({ ...geometry, state, title: `OCSS ${views[i].id} – ${views[j].id}: ${rows.map((r) => r.state).join(' / ')} (${dialer} dials)` });
    }
  }
  return out;
}
