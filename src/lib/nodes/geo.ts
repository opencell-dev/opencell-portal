import { and, between, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { nodes, rateCenters } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';

// Where a node is (portal spec §6.1, §10). The exact pin is for the node's
// operator and admins; everything public goes through roundPublic first, on
// the server, so an exact value never reaches a visitor's browser.

export const PUBLIC_ROUND = 0.01;

export interface LatLon {
  lat: number;
  lon: number;
}

const round2 = (x: number) => Number((Math.round(x / PUBLIC_ROUND) * PUBLIC_ROUND).toFixed(2));

/** A pin as the public may see it: two decimals, about a kilometre. */
export function roundPublic(lat: number, lon: number): LatLon {
  return { lat: round2(lat), lon: round2(lon) };
}

const coord = (min: number, max: number, what: string) =>
  z
    .union([z.number(), z.string().max(32).trim().min(1, `Please enter the ${what}.`)], `Please enter the ${what}.`)
    .transform(Number)
    .pipe(z.number(`Please enter the ${what} as a number.`).min(min, `That ${what} is outside the area OpenCell serves.`).max(max, `That ${what} is outside the area OpenCell serves.`))
    .transform((x) => Number(x.toFixed(6)));

/** A pin in the NANP area, to 6 decimals. */
export const pinSchema = z.object({ lat: coord(14, 72, 'latitude'), lon: coord(-180, -50, 'longitude') });

const RAD = Math.PI / 180;

/** The great-circle distance in km (R = 6371). */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The nearest node still on the network, for the review (spec §6.2). */
export function nearestNode(ctx: Ctx, p: LatLon, exceptNodeId?: number): { nodeId: number; cellName: string; km: number } | null {
  const rows = ctx.db.select({ id: nodes.id, cellName: nodes.cellName, lat: nodes.lat, lon: nodes.lon }).from(nodes).where(isNull(nodes.revokedAt)).all();
  let best: { nodeId: number; cellName: string; km: number } | null = null;
  for (const r of rows) {
    if (r.id === exceptNodeId) continue;
    const km = haversineKm(p, r);
    if (!best || km < best.km) best = { nodeId: r.id, cellName: r.cellName, km };
  }
  return best;
}

/** How far around the pin the first look goes before scanning the whole table. */
const BOX_DEG = 1.5;

/** The nearest rate center with coordinates (the check on the requester's state, plan P3 decision 7); null: none known. */
export function nearestRateCenter(ctx: Ctx, p: LatLon): { region: string; name: string; km: number } | null {
  const select = () => ctx.db.select({ region: rateCenters.region, display: rateCenters.display, lat: rateCenters.lat, lon: rateCenters.lon }).from(rateCenters);
  const near = select()
    .where(and(between(rateCenters.lat, p.lat - BOX_DEG, p.lat + BOX_DEG), between(rateCenters.lon, p.lon - BOX_DEG, p.lon + BOX_DEG)))
    .all();
  const rows = near.length > 0 ? near : select().where(and(isNotNull(rateCenters.lat), isNotNull(rateCenters.lon))).all();
  let best: { region: string; name: string; km: number } | null = null;
  for (const r of rows) {
    if (r.lat === null || r.lon === null) continue;
    const km = haversineKm(p, { lat: r.lat, lon: r.lon });
    if (!best || km < best.km) best = { region: r.region, name: r.display, km };
  }
  return best;
}
