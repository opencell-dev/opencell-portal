'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { AdminResult } from '@/app/actions/admin';
import { revokeCell } from '@/lib/admin/cells';
import { askWithin } from '@/lib/core-ask';
import { appCtx } from '@/lib/ctx';
import { publicMessage } from '@/lib/errors';
import { coreActor } from '@/lib/site';
import { freshAdmin, requestMeta } from '@/server/request';

const coreField = z.string().regex(/^[a-z][a-z0-9]{0,15}$/);
const cellField = z.number().int().min(1).max(0xffffffff);

/** Revoke a cell (portal spec §3: a fresh passkey); the admin types its name, which the core is asked for. */
export async function revokeCellAction(coreId: string, cellId: number, confirmName: string): Promise<AdminResult> {
  const f = await freshAdmin();
  if (!f.ok) return f;
  const core = coreField.safeParse(coreId);
  const cell = cellField.safeParse(cellId);
  const name = z.string().max(64).safeParse(confirmName);
  if (!core.success || !cell.success || !name.success) return { ok: false, message: 'No such cell.' };
  const ctx = appCtx();
  if (ctx.config.site !== 'portal') return { ok: false, message: 'Cells are handled on the subscriber portal.' };
  const h = ctx.cores.find((c) => c.id === core.data);
  if (!h) return { ok: false, message: 'No such core.' };
  const now = await askWithin(h, 'cell.status', () => h.core.cellStatus(coreActor(ctx.config.site, f.s.user.id), cell.data), 3000);
  if (!now?.[0]) return { ok: false, message: `${core.data} didn't answer, or has no cell ${cell.data}. Nothing was changed.` };
  if (now[0].name !== name.data.trim()) return { ok: false, message: 'Type the cell’s name exactly to confirm.' };
  try {
    const r = await revokeCell(ctx, f.s.user.id, core.data, cell.data, await requestMeta());
    if (!r.ok) return { ok: false, message: r.error };
    revalidatePath('/admin/cells');
    return { ok: true, message: `Cell ${cell.data} on ${core.data} is revoked.` };
  } catch (e) {
    return { ok: false, message: publicMessage(e, 'Revoking did not work. Please try again.') };
  }
}
