import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { exchanges, npas, rateCenters } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';
import { homeCoreOf } from './blocks';
import { type Side, sideOfHome } from './homing';
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
/** The most places one name search looks at. Keys ascend, so a short exact name is among them. */
const MAX_MATCHES = 500;

/**
 * The places whose name starts with `name` (rcKey): by the rate center's own
 * key, through its index, and by its pretty name and normalized key on the
 * much smaller rate_centers table, hyphens read as spaces (wilkes barre,
 * trois rivieres). In two steps, so a key press never reads every exchange:
 * it runs on the portal's one thread.
 */
function namedPlaces(ctx: Ctx, name: string, region: string | null) {
  const inRegion = (col: typeof exchanges.region | typeof rateCenters.region) => (region ? eq(col, region) : undefined);
  const byKey = ctx.db
    .selectDistinct({ region: exchanges.region, rateCenter: exchanges.rateCenter })
    .from(exchanges)
    .where(and(gte(exchanges.rateCenter, name), lt(exchanges.rateCenter, `${name}\uffff`), inRegion(exchanges.region)))
    .orderBy(asc(exchanges.rateCenter))
    .limit(MAX_MATCHES)
    .all();
  const pattern = likePrefix(name.replace(/-/g, ' '));
  const byName = ctx.db
    .select({ region: rateCenters.region, rateCenter: rateCenters.name })
    .from(rateCenters)
    .where(
      and(
        sql`(replace(${rateCenters.name}, '-', ' ') LIKE ${pattern} ESCAPE '\\' OR replace(upper(replace(${rateCenters.display}, '.', ' ')), '-', ' ') LIKE ${pattern} ESCAPE '\\')`,
        inRegion(rateCenters.region),
      ),
    )
    .orderBy(asc(rateCenters.name))
    .limit(MAX_MATCHES)
    .all();
  const seen = new Map([...byKey, ...byName].map((p) => [`${p.region}|${p.rateCenter}`, p]));
  return [...seen.values()].slice(0, MAX_MATCHES);
}

function nameRows(ctx: Ctx, name: string, region: string | null): Row[] {
  const places = namedPlaces(ctx, name, region);
  if (places.length === 0) return [];
  const pairs = places.map((p) => sql`(${p.region}, ${p.rateCenter})`);
  return offered(ctx, sql`(${exchanges.region}, ${exchanges.rateCenter}) IN (VALUES ${sql.join(pairs, sql`, `)})`);
}

/** The offered exchanges' rows matching `where`, with their rate center's name and position. */
function offered(ctx: Ctx, where: SQL | undefined) {
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

/** Which side homes an NPA: from the table, or the state rule until it is known (blocks.ts). */
function sideOf(ctx: Ctx, npa: string): Side | null {
  const home = homeCoreOf(ctx, npa);
  return home === null ? null : sideOfHome(home);
}

function group(ctx: Ctx, rows: Row[]): Group[] {
  const sides = new Map<string, Side | null>();
  const sideOfRow = (npa: string) => {
    if (!sides.has(npa)) sides.set(npa, sideOf(ctx, npa));
    return sides.get(npa)!;
  };
  const out = new Map<string, Group>();
  for (const r of rows) {
    if (sideOfRow(r.npa) === null) continue;
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
    side: sideOf(ctx, head.slice(0, 3))!,
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
      const inIt = region ? rank(group(ctx, offered(ctx, eq(exchanges.region, region)))) : [];
      // Two letters that are a region's code mean the region; a full name
      // can be a place as well (Ohio is a state; Washington a state and a city).
      if (inIt.length > 0 && /^\p{L}{2}$/u.test(t.text)) return inIt.slice(0, limit).map((g) => toPlace(ctx, g));
      // "Lancaster, PA", or "Lancaster PA" when PA is a region with places.
      const comma = /^(.*?)\s*,\s*([^,]+)$/.exec(t.text);
      const bare = /^(.+?)\s+(\p{L}{2})$/u.exec(t.text);
      if (comma && !regionCode(comma[2])) return [];
      const suffix = comma ?? bare;
      const key = rcKey(suffix ? suffix[1] : t.text);
      const scoped = suffix ? group(ctx, nameRows(ctx, key, regionCode(suffix[2]))) : [];
      if (scoped.length > 0 || comma) return rank(scoped, key).slice(0, limit).map((g) => toPlace(ctx, g));
      const name = rcKey(t.text);
      if (name.length < 2) return [];
      const named = rank(group(ctx, nameRows(ctx, name, null)), name);
      const seen = new Set(named.map((g) => `${g.region}|${g.rateCenter}`));
      return [...named, ...inIt.filter((g) => !seen.has(`${g.region}|${g.rateCenter}`))]
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
  const side = sideOf(ctx, row.npa);
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
