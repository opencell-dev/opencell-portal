import { eq } from 'drizzle-orm';
import { npas, settings } from '@/db/schema';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';

// Where a number is homed (portal spec §4.3): every geographic NPA is its
// own block, homed by its state or province, split at the Mississippi. East
// is core 1 (Virginia), West core 2 (Oregon). Until P5 every block still
// lives on core 1 (coreFor, route.ts); P2 shows the side on the confirm step.

export type Side = 'east' | 'west';

// The §4.3 table verbatim. Region codes are what the NANPA importer stores:
// US state and territory codes, Canadian province codes, and ISO-style codes
// for the other NANP countries. Two codes mean two places (KY: Kentucky and
// the Cayman Islands; MS: Mississippi and Montserrat) — both are East either way.
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

export function sideOfRegion(region: string): Side | null {
  if (EAST.has(region)) return 'east';
  if (WEST.has(region)) return 'west';
  return null;
}

const overrideKey = (npa: string) => `npa_home:${npa}`;

/**
 * An NPA's home side: an admin's override (settings `npa_home:<npa>`) first,
 * else its region's. Null for an NPA NANPA doesn't list, or one that is not
 * geographic (500, 8xx: never a block, spec §4.3), whatever an override says.
 */
export function sideOfNpa(ctx: Ctx, npa: string): Side | null {
  const row = ctx.db.select().from(npas).where(eq(npas.npa, npa)).get();
  if (!row?.geographic) return null;
  const o = ctx.db.select().from(settings).where(eq(settings.key, overrideKey(npa))).get();
  if (o?.value === 'east' || o?.value === 'west') return o.value;
  return sideOfRegion(row.region);
}

/**
 * Set (or with null, clear) an NPA's home override. Recorded here only: on
 * the cores an override is a routing-table change, signed offline (spec
 * §4.3), which P5 wires up.
 */
export function setNpaOverride(ctx: Ctx, npa: string, side: Side | null, actorId: number): void {
  if (!/^[2-9]\d{2}$/.test(npa)) throw new Error('npa must be 3 digits');
  if (side === null) {
    ctx.db.delete(settings).where(eq(settings.key, overrideKey(npa))).run();
  } else {
    ctx.db
      .insert(settings)
      .values({ key: overrideKey(npa), value: side })
      .onConflictDoUpdate({ target: settings.key, set: { value: side } })
      .run();
  }
  writeAudit(ctx, { actorId, action: 'npa.home_override', target: `npa:${npa}`, detail: { side } });
}

/** The serving core as the confirm step names it (P2 decision 7). */
export function sideLabel(side: Side): string {
  return side === 'east' ? 'East (core 1)' : 'West (core 2)';
}
