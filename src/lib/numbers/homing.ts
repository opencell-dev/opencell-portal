import { eq } from 'drizzle-orm';
import { EAST_STATES, WEST_STATES } from '@/core/state-codes';
import { npas } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';

// Where a number is homed (portal spec §4.3): every geographic NPA is its
// own block, homed by its state or province, split at the Mississippi. East
// is core 1 (Virginia), West core 2 (Oregon). The cores' signed table is the
// truth (blocks.ts); this rule is what it was built by, and the answer until
// the portal has heard it.

export type Side = 'east' | 'west';

// The §4.3 table verbatim, by the plain region a person picks. Region codes are
// what the NANPA importer stores: US state and territory codes, Canadian
// province codes, and ISO-style codes for the other NANP countries. Two codes
// mean two places (KY: Kentucky and the Cayman Islands; MS: Mississippi and
// Montserrat) — both are East either way. An NPA's own code is its stateCode
// (sideOfStateCode).
const EAST = new Set([
  // States wholly east of the Mississippi.
  'ME', 'NH', 'VT', 'MA', 'RI', 'CT', 'NY', 'NJ', 'PA', 'DE', 'MD', 'VA', 'WV', 'NC', 'SC', 'GA', 'FL', 'AL', 'OH', 'MI', 'IN',
  // On the river, mostly east.
  'WI', 'IL', 'KY', 'TN', 'MS',
  'DC', 'PR', 'VI',
  'ON', 'QC', 'NB', 'NS', 'PE', 'NL',
  // The other Caribbean (and Atlantic) NANP countries.
  'AG', 'AI', 'BB', 'BM', 'BS', 'DM', 'DO', 'GD', 'JM', 'KN', 'LC', 'SX', 'TC', 'TT', 'VC', 'VG',
]);
const WEST = new Set([
  // States wholly west of the Mississippi.
  'WA', 'OR', 'CA', 'NV', 'ID', 'MT', 'WY', 'UT', 'AZ', 'NM', 'CO', 'ND', 'SD', 'NE', 'KS', 'OK', 'TX',
  // On the river, mostly west (MN and LA straddle it: most of their area is west).
  'MN', 'IA', 'MO', 'AR', 'LA',
  'AK', 'HI', 'GU', 'MP', 'AS',
  'MB', 'SK', 'AB', 'BC', 'YT', 'NT', 'NU',
]);

/** Every region code the §4.3 table knows, sorted: what a node request's state field offers. */
export const REGION_CODES: readonly string[] = [...EAST, ...WEST].sort();

export function sideOfRegion(region: string): Side | null {
  if (EAST.has(region)) return 'east';
  if (WEST.has(region)) return 'west';
  return null;
}

/** A routing-table state code's side (OCSS spec §3.3), or null for one in neither list. */
export function sideOfStateCode(code: string): Side | null {
  if (EAST_STATES.has(code)) return 'east';
  if (WEST_STATES.has(code)) return 'west';
  return null;
}

/**
 * An NPA's home side by the state rule. Null for an NPA NANPA doesn't list, or
 * one that is not geographic (500, 8xx: never a block, spec §4.3). A row with
 * no state code yet (imported before P5) goes by its region: KY and MS collide
 * there, but each pair is East either way.
 */
export function sideOfNpa(ctx: Ctx, npa: string): Side | null {
  const row = ctx.db.select().from(npas).where(eq(npas.npa, npa)).get();
  if (!row?.geographic) return null;
  return row.stateCode ? sideOfStateCode(row.stateCode) : sideOfRegion(row.region);
}

/** The side a home core serves, as the confirm page labels it: core 1 is East, any other West. */
export function sideOfHome(homeCore: number): Side {
  return homeCore === 1 ? 'east' : 'west';
}

/** The serving core as the confirm step names it (P2 decision 7). */
export function sideLabel(side: Side): string {
  return side === 'east' ? 'East (core 1)' : 'West (core 2)';
}
