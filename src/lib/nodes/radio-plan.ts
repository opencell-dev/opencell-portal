import { randomBytes } from 'node:crypto';
import { isNull } from 'drizzle-orm';
import { nodes } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';

// The radio plan at approval (plan P3, decision 9): group 0 (no channel list,
// the cell runs its configured anchor) and the lowest anchor no other node
// uses, since distinct anchors never share a sync channel in a frame (oc_phy.h).

const ANCHORS_915 = 52;
const ANCHORS_2400 = 40;

/** An anchor's frequency in MHz. */
export function anchorMhz(anchor: number, band: 915 | 2400 = 915): number {
  const count = band === 915 ? ANCHORS_915 : ANCHORS_2400;
  if (!Number.isInteger(anchor) || anchor < 0 || anchor >= count) throw new RangeError(`anchor ${anchor} is not in the ${band} band`);
  return band === 915 ? 902.25 + 0.5 * anchor : 2402 + 2 * anchor;
}

/** "917.25 MHz, anchor 30" */
export function channelLabel(anchor: number): string {
  return `${anchorMhz(anchor).toFixed(2)} MHz, anchor ${anchor}`;
}

/** The lowest anchor in the band no unrevoked node uses; all used: the least used, lowest first. */
export function pickAnchor(ctx: Ctx): number {
  const uses = new Array<number>(ANCHORS_915).fill(0);
  for (const { anchor } of ctx.db.select({ anchor: nodes.anchor }).from(nodes).where(isNull(nodes.revokedAt)).all()) {
    if (anchor >= 0 && anchor < ANCHORS_915) uses[anchor]++;
  }
  return uses.indexOf(Math.min(...uses));
}

/** A random u32 for the cell's `cell_seed`, never 0. */
export function newCellSeed(): number {
  for (;;) {
    const s = randomBytes(4).readUInt32BE(0);
    if (s !== 0) return s;
  }
}

/**
 * The name a cell carries on its core: its state and the request's number, like
 * `md-12`. Never the site name, which may be an address (decision 16): any
 * subscriber registered on the cell sees this name on their number's card.
 */
export function cellName(region: string, requestId: number): string {
  const r = region.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${r || 'node'}-${requestId}`.slice(0, 31);
}

/** The cell certificate's CN: always the portal's, never the CSR's (spec §8.3). oc-ca's rule: ^[A-Za-z0-9._-]{1,64}$. */
export function certCn(cellId: number, name: string): string {
  return `cell${cellId}-${name}`;
}
