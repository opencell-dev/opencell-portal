'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AdminResult } from '@/app/actions/admin';
import { npas, settings } from '@/db/schema';
import { WANTED_PREFIX } from '@/lib/admin/blocks';
import { writeAudit } from '@/lib/audit';
import { appCtx } from '@/lib/ctx';
import { freshAdmin, requestMeta } from '@/server/request';

const npaField = z.string().regex(/^[2-9]\d\d$/);

/**
 * The home an admin wants for an NPA (portal spec §4.3). It changes no routing:
 * only the root key can, on the laptop; /admin/numbers prints the command.
 * null clears the wish. A fresh passkey, as the plan's Global Constraints list.
 */
export async function npaOverrideAction(npa: string, homeCore: number | null): Promise<AdminResult> {
  const f = await freshAdmin();
  if (!f.ok) return f;
  const ctx = appCtx();
  if (ctx.config.site !== 'portal') return { ok: false, message: 'NPAs are handled on the subscriber portal.' };
  const n = npaField.safeParse(npa);
  if (!n.success) return { ok: false, message: 'That is not an area code.' };
  const row = ctx.db.select().from(npas).where(eq(npas.npa, n.data)).get();
  if (!row?.geographic) return { ok: false, message: `${n.data} is not a geographic area code.` };
  if (homeCore !== null && !ctx.cores.some((h) => h.coreNo === homeCore)) return { ok: false, message: 'There is no such core.' };
  const key = `${WANTED_PREFIX}${n.data}`;
  if (homeCore === null) {
    ctx.db.delete(settings).where(eq(settings.key, key)).run();
  } else {
    const value = String(homeCore);
    ctx.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  }
  writeAudit(ctx, { actorId: f.s.user.id, action: 'npa.home_override', target: `npa:${n.data}`, detail: { home: homeCore }, ip: (await requestMeta()).ip });
  revalidatePath('/admin/numbers');
  return { ok: true, message: homeCore === null ? `No home is wanted for ${n.data} any more.` : `Noted: ${n.data} on core ${homeCore}. Routing has not changed: run the command below on the laptop.` };
}
