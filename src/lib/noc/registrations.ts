import type { Registration } from '@/core/types';
import { REG_LIST_MAX } from '@/core/wire-noc';
import { writeAudit } from '@/lib/audit';
import type { Reported } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { coreActor } from '@/lib/site';
import { askNoc } from './snapshot';

// Who is registered where (reg.list, plan N2a), read by a staff member under
// their own account: the core audits each read with that account (a page
// that names a cell or a cursor as itself; a plain first page in its
// once-a-minute count), and the portal audits it too. Numbers are shown
// unmasked to admins and NOC operators alike (ruling 2026-10-01 #8/#9).

export const REG_DEADLINE_MS = 3000;

export interface RegQuery {
  core: string;
  cellId?: number;
  /** The last number of the page before (a full number). */
  after?: string;
}

export interface RegPage {
  rows: Reported<Registration[]>;
  /** The core may have more after the last row (it gave a whole page). */
  more: boolean;
}

/** One page of a core's registrations, as `userId`, audited in the portal as `noc.registrations` (or `noc.cell.terminals` for one cell's). */
export async function registrationsPage(ctx: Ctx, q: RegQuery, userId: number, ip: string): Promise<RegPage> {
  const h = ctx.cores.find((c) => c.id === q.core);
  if (!h) return { rows: { state: 'unreachable' }, more: false };
  const as = coreActor(ctx.config.site, userId);
  const rows = await askNoc(h, 'reg.list', () => h.core.regList(as, { cellId: q.cellId, after: q.after }), REG_DEADLINE_MS, ctx.now());
  writeAudit(ctx, {
    actorId: userId,
    action: q.after === undefined && q.cellId !== undefined ? 'noc.cell.terminals' : 'noc.registrations',
    target: q.cellId !== undefined ? `cell:${q.core}/${q.cellId}` : `core:${q.core}`,
    detail: { core: q.core, cell: q.cellId ?? null, after: q.after ?? null, rows: rows.state === 'ok' ? rows.value.length : rows.state },
    ip,
  });
  return { rows, more: rows.state === 'ok' && rows.value.length >= REG_LIST_MAX };
}
