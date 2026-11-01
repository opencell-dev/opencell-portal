import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { nodes, nodeState } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';
import { roundPublic } from '@/lib/nodes/geo';

// The public coverage map (portal spec §5, §10). What anyone may see of a node:
// a number, its state or province, a position rounded to about a kilometre here
// on the server, and whether it is online. Never an operator, a site name (it may
// be an address) or a subscriber's location. Approved nodes that have been set up.

export interface PublicNode {
  label: string;
  region: string;
  lat: number;
  lon: number;
  online: boolean | null;
}

const KEEP_MS = 60_000;

// One per process, as __ocCores is: Next can load this module more than once.
const g = globalThis as typeof globalThis & { __ocPublicNodes?: WeakMap<object, { at: number; rows: PublicNode[] }> };

export function publicNodes(ctx: Ctx): PublicNode[] {
  if (ctx.config.site !== 'portal') return [];
  g.__ocPublicNodes ??= new WeakMap();
  const kept = g.__ocPublicNodes.get(ctx);
  if (kept && ctx.now() - kept.at < KEEP_MS) return kept.rows;
  const rows = ctx.db
    .select({ id: nodes.id, region: nodes.region, lat: nodes.lat, lon: nodes.lon, online: nodeState.online })
    .from(nodes)
    .leftJoin(nodeState, eq(nodeState.nodeId, nodes.id))
    .where(and(isNull(nodes.revokedAt), isNotNull(nodes.certFpr)))
    .orderBy(asc(nodes.id))
    .all()
    .map((n) => ({ label: `Node ${n.id}`, region: n.region, ...roundPublic(n.lat, n.lon), online: n.online }));
  g.__ocPublicNodes.set(ctx, { at: ctx.now(), rows });
  return rows;
}

/** A node appeared or went: the next look reads the table. */
export function forgetPublicNodes(ctx: Ctx): void {
  g.__ocPublicNodes?.delete(ctx);
}
