import { and, eq } from 'drizzle-orm';
import { type CellStatus, isCoreError } from '@/core/types';
import { nodes, users } from '@/db/schema';
import type { Result } from '@/lib/accounts';
import { writeAudit } from '@/lib/audit';
import { askWithin, tryWithin } from '@/lib/core-ask';
import { forgetPublicNodes } from '@/lib/coverage';
import type { Ctx } from '@/lib/ctx';
import { closeRevokedNode, type DowntimeWindow, downtimeOf, forgetSnapshot } from '@/lib/nodes/my-nodes';
import type { RequestMeta } from '@/lib/sessions';
import { coreActor } from '@/lib/site';

// Every core's cells beside the portal's nodes (portal spec §1): a cell the
// portal didn't make shows as added outside it (decision 27) and can still be
// revoked here; it never reaches My nodes or the map.

const READ_MS = 3000;
const WRITE_MS = 5000;
const NOT_HERE = 'Cells are handled on the subscriber portal.';

export interface CellRow extends CellStatus {
  node: { id: number; siteName: string; operator: string | null; contactPhone: string; lat: number; lon: number; anchor: number; downtime: DowntimeWindow[] } | null;
  outside: boolean;
}

export async function allCells(ctx: Ctx, adminId: number): Promise<{ coreId: string; reachable: boolean; rows: CellRow[] }[]> {
  const actor = coreActor(ctx.config.site, adminId);
  return Promise.all(
    ctx.cores.map(async (h) => {
      const cells = await askWithin(h, 'cell.status', () => h.core.cellStatus(actor), READ_MS);
      if (cells === null) return { coreId: h.id, reachable: false, rows: [] };
      const mine = ctx.db.select({ n: nodes, name: users.name, email: users.email }).from(nodes).leftJoin(users, eq(users.id, nodes.userId)).where(eq(nodes.coreId, h.id)).all();
      const byCell = new Map(mine.map((m) => [m.n.cellId, m]));
      const rows = cells.map((c): CellRow => {
        const m = byCell.get(c.cellId);
        return {
          ...c,
          outside: !m,
          node: m
            ? { id: m.n.id, siteName: m.n.siteName, operator: m.name === null ? null : `${m.name} (${m.email})`, contactPhone: m.n.contactPhone, lat: m.n.lat, lon: m.n.lon, anchor: m.n.anchor, downtime: downtimeOf(ctx, m.n.id) }
            : null,
        };
      });
      return { coreId: h.id, reachable: true, rows };
    }),
  );
}

/** cell.revoke: the core unpins it and drops its link. Its node, if the portal made it, closes with it: tokens void, the operator told. */
export async function revokeCell(ctx: Ctx, adminId: number, coreId: string, cellId: number, meta: RequestMeta): Promise<Result> {
  if (ctx.config.site !== 'portal') return { ok: false, error: NOT_HERE };
  const h = ctx.cores.find((c) => c.id === coreId);
  if (!h) return { ok: false, error: 'No such core.' };
  const actor = coreActor(ctx.config.site, adminId);
  const r = await tryWithin(h, 'cell.revoke', () => h.core.cellRevoke(actor, cellId), WRITE_MS);
  if (!r.ok) {
    if ('error' in r && isCoreError(r.error) && r.error.code === 'not_found') return { ok: false, error: `${coreId} has no cell ${cellId}.` };
    return { ok: false, error: `${coreId} didn't answer; nothing was changed. Please try again in a minute.` };
  }
  const node = ctx.db.select().from(nodes).where(and(eq(nodes.coreId, coreId), eq(nodes.cellId, cellId))).get();
  if (node) closeRevokedNode(ctx, node, adminId);
  writeAudit(ctx, { actorId: adminId, action: 'cell.revoke', target: `${coreId}/${cellId}`, detail: { node: node?.id ?? null }, ip: meta.ip });
  forgetPublicNodes(ctx);
  forgetSnapshot(ctx, coreId);
  return { ok: true };
}
