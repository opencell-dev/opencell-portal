import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { exchanges, npas, rateCenters } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';
import { type Side, sideOfNpa } from './homing';
import { parseTyped } from './input';
import { rcKey } from './nanpa-parse';

// Place search (portal spec §4.1 "Where?"): a city, a state, an area code or
// an exchange becomes a list of places, each a rate center with the real
// exchanges it has (§4.4). Only exchanges that are offered for new numbers
// count: not withdrawn, in a geographic NPA with a known home side (§4.3).

export interface Place {
  /** "Lancaster, PA (717-291, +4 more)" */
  label: string;
  region: string;
  rateCenter: string;
  /** +8831NPANXX, offered ones only, ascending (the asked-for one first, for an exchange search). */
  exchanges: string[];
  side: Side;
}

interface Row {
  npaNxx: string;
  npa: string;
  region: string;
  rateCenter: string;
  display: string | null;
  lat: number | null;
  lon: number | null;
}

// Full names people type for a region (Pennsylvania, Ontario); the codes themselves work too.
const REGION_NAMES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT',
  DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', 'WASHINGTON DC': 'DC', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI',
  IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME',
  MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO',
  MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM',
  'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
  PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN',
  TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
  WYOMING: 'WY', 'PUERTO RICO': 'PR', 'US VIRGIN ISLANDS': 'VI', 'VIRGIN ISLANDS': 'VI', GUAM: 'GU',
  'NORTHERN MARIANA ISLANDS': 'MP', 'AMERICAN SAMOA': 'AS', ALBERTA: 'AB', 'BRITISH COLUMBIA': 'BC', MANITOBA: 'MB',
  'NEW BRUNSWICK': 'NB', 'NEWFOUNDLAND AND LABRADOR': 'NL', NEWFOUNDLAND: 'NL', 'NOVA SCOTIA': 'NS',
  'NORTHWEST TERRITORIES': 'NT', NUNAVUT: 'NU', ONTARIO: 'ON', 'PRINCE EDWARD ISLAND': 'PE', QUEBEC: 'QC',
  SASKATCHEWAN: 'SK', YUKON: 'YT',
};

/** "LANCASTER" → "Lancaster", "WILKES-BARRE" → "Wilkes-Barre": for a rate center Local Calling Guide has no name for. */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s\-'/])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

const ex = (npaNxx: string) => `+8831${npaNxx}`;
const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The offered exchanges' rows matching `where`, with their rate center's name and position. */
function offered(ctx: Ctx, where: ReturnType<typeof and>) {
  return ctx.db
    .select({
      npaNxx: exchanges.npaNxx,
      npa: exchanges.npa,
      region: exchanges.region,
      rateCenter: exchanges.rateCenter,
      display: rateCenters.display,
      lat: rateCenters.lat,
      lon: rateCenters.lon,
    })
    .from(exchanges)
    .innerJoin(npas, eq(npas.npa, exchanges.npa))
    .leftJoin(rateCenters, and(eq(rateCenters.region, exchanges.region), eq(rateCenters.name, exchanges.rateCenter)))
    .where(and(isNull(exchanges.withdrawnAt), eq(npas.geographic, true), sql`${npas.region} <> ''`, where))
    .orderBy(asc(exchanges.npaNxx))
    .all() as Row[];
}

interface Group {
  region: string;
  rateCenter: string;
  display: string;
  lat: number | null;
  lon: number | null;
  rows: Row[];
}

function group(ctx: Ctx, rows: Row[]): Group[] {
  const sides = new Map<string, Side | null>();
  const sideOf = (npa: string) => {
    if (!sides.has(npa)) sides.set(npa, sideOfNpa(ctx, npa));
    return sides.get(npa)!;
  };
  const out = new Map<string, Group>();
  for (const r of rows) {
    if (sideOf(r.npa) === null) continue;
    const k = `${r.region}|${r.rateCenter}`;
    let g = out.get(k);
    if (!g) {
      g = { region: r.region, rateCenter: r.rateCenter, display: r.display ?? titleCase(r.rateCenter), lat: r.lat, lon: r.lon, rows: [] };
      out.set(k, g);
    }
    g.rows.push(r);
  }
  return [...out.values()];
}

function toPlace(ctx: Ctx, g: Group, first?: string): Place {
  const codes = g.rows.map((r) => r.npaNxx);
  if (first && codes.includes(first)) {
    codes.splice(codes.indexOf(first), 1);
    codes.unshift(first);
  }
  const head = codes[0];
  const more = codes.length > 1 ? `, +${codes.length - 1} more` : '';
  return {
    label: `${g.display}, ${g.region} (${head.slice(0, 3)}-${head.slice(3)}${more})`,
    region: g.region,
    rateCenter: g.rateCenter,
    exchanges: codes.map(ex),
    side: sideOfNpa(ctx, head.slice(0, 3))!,
  };
}

/** Squared degrees, longitude scaled by latitude: only ever compared (P2 decision 6: a tie-break). */
function dist(a: Group, b: Group): number {
  if (a.lat === null || a.lon === null || b.lat === null || b.lon === null) return Number.POSITIVE_INFINITY;
  const k = Math.cos((a.lat * Math.PI) / 180);
  return (a.lat - b.lat) ** 2 + ((a.lon - b.lon) * k) ** 2;
}

/**
 * Exact-name matches first, then by how many exchanges a place has (a city
 * before a hamlet); ties go to the place nearer the first result, then by name.
 */
function rank(groups: Group[], exactKey?: string): Group[] {
  const exact = (g: Group) => (exactKey !== undefined && (g.rateCenter === exactKey || rcKey(g.display) === exactKey) ? 0 : 1);
  const byWeight = [...groups].sort((a, b) => exact(a) - exact(b) || b.rows.length - a.rows.length || a.display.localeCompare(b.display));
  const top = byWeight[0];
  if (!top) return [];
  return [top, ...byWeight.slice(1).sort((a, b) => exact(a) - exact(b) || b.rows.length - a.rows.length || dist(top, a) - dist(top, b) || a.display.localeCompare(b.display))];
}

function regionCode(text: string): string | null {
  const k = rcKey(text).replace(/-/g, ' ');
  if (/^[A-Z]{2}$/.test(k)) return k;
  return REGION_NAMES[k] ?? null;
}

/**
 * Suggestions for what was typed: a place name (a prefix, optionally
 * ", ST"), a region code or name (its places, biggest first), an area code
 * (its places), an exchange or a whole number (its place). Nothing for
 * anything else.
 */
export function searchPlaces(ctx: Ctx, q: string, limit = 10): Place[] {
  const t = parseTyped(q);
  switch (t.kind) {
    case 'bad':
      return [];
    case 'npa':
      return rank(group(ctx, offered(ctx, and(eq(exchanges.npa, t.npa))))).slice(0, limit).map((g) => toPlace(ctx, g));
    case 'exchange':
    case 'number': {
      const code = (t.kind === 'exchange' ? t.exchange : t.number).slice(5, 11);
      const p = exchangeOffered(ctx, ex(code));
      if (!p) return [];
      return group(ctx, offered(ctx, and(eq(exchanges.region, p.region), eq(exchanges.rateCenter, p.rateCenter)))).map((g) => toPlace(ctx, g, code));
    }
    case 'text': {
      const region = regionCode(t.text);
      if (region) {
        const rows = offered(ctx, and(eq(exchanges.region, region)));
        if (rows.length > 0) return rank(group(ctx, rows)).slice(0, limit).map((g) => toPlace(ctx, g));
      }
      const m = /^(.*?)\s*,\s*([^,]+)$/.exec(t.text);
      const name = rcKey(m ? m[1] : t.text);
      const inRegion = m ? regionCode(m[2]) : null;
      if (name === '' || (m && !inRegion)) return [];
      const pattern = likePrefix(name);
      const rows = offered(
        ctx,
        and(
          sql`(${exchanges.rateCenter} LIKE ${pattern} ESCAPE '\\' OR upper(replace(${rateCenters.display}, '.', ' ')) LIKE ${pattern} ESCAPE '\\')`,
          inRegion ? eq(exchanges.region, inRegion) : undefined,
        ),
      );
      return rank(group(ctx, rows), name)
        .slice(0, limit)
        .map((g) => toPlace(ctx, g));
    }
  }
}

/** A place's offered exchanges (+8831NPANXX, ascending): "Other exchange in this area". */
export function exchangesOfPlace(ctx: Ctx, region: string, rateCenter: string): string[] {
  return group(ctx, offered(ctx, and(eq(exchanges.region, region), eq(exchanges.rateCenter, rateCenter)))).flatMap((g) => g.rows.map((r) => ex(r.npaNxx)));
}

/** Where an exchange is and which side homes it, when it is offered for new numbers; null otherwise. */
export function exchangeOffered(ctx: Ctx, exchange: string): { region: string; rateCenter: string; display: string; side: Side } | null {
  if (!/^\+8831\d{6}$/.test(exchange)) return null;
  const [row] = offered(ctx, and(eq(exchanges.npaNxx, exchange.slice(5))));
  if (!row) return null;
  const side = sideOfNpa(ctx, row.npa);
  if (!side) return null;
  return { region: row.region, rateCenter: row.rateCenter, display: row.display ?? titleCase(row.rateCenter), side };
}

/** The place an issued number is in, for its card and the confirm step; any exchange, withdrawn or not. */
export function placeOfNumber(ctx: Ctx, number: string): string | null {
  const row = ctx.db
    .select({ region: exchanges.region, rateCenter: exchanges.rateCenter, display: rateCenters.display })
    .from(exchanges)
    .leftJoin(rateCenters, and(eq(rateCenters.region, exchanges.region), eq(rateCenters.name, exchanges.rateCenter)))
    .where(eq(exchanges.npaNxx, number.slice(5, 11)))
    .get();
  return row ? `${row.display ?? titleCase(row.rateCenter)}, ${row.region}` : null;
}

/**
 * Why an exchange is not offered for new numbers (Review Focus: a
 * non-geographic or withdrawn exchange gets its own message), or null when it is.
 */
export function whyNotOffered(ctx: Ctx, exchange: string): string | null {
  if (exchangeOffered(ctx, exchange)) return null;
  const code = exchange.slice(5);
  const row = /^\d{6}$/.test(code) ? ctx.db.select().from(exchanges).where(eq(exchanges.npaNxx, code)).get() : undefined;
  const npa = ctx.db.select().from(npas).where(eq(npas.npa, code.slice(0, 3))).get();
  if (npa && !npa.geographic) return `Area code ${npa.npa} is not tied to a place, so OpenCell does not offer numbers in it.`;
  if (row?.withdrawnAt != null) return `Exchange ${code.slice(0, 3)}-${code.slice(3)} is no longer offered for new numbers. Pick another.`;
  if (row) return `Numbers in area code ${code.slice(0, 3)} aren't offered yet.`;
  return `${code.slice(0, 3)}-${code.slice(3)} is not a real exchange. Pick a place to see the exchanges it has.`;
}
