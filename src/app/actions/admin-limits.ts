'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { FormState } from '@/app/actions/auth';
import { appCtx } from '@/lib/ctx';
import { decideLimitRequest } from '@/lib/numbers/limits';
import { requestMeta, requireAdmin } from '@/server/request';

const decideSchema = z.discriminatedUnion('outcome', [
  z.object({ id: z.coerce.number().int().positive(), outcome: z.literal('raised'), limit: z.coerce.number().int() }),
  z.object({ id: z.coerce.number().int().positive(), outcome: z.literal('declined'), note: z.string().max(4000) }),
]);

/**
 * Raise a subscriber's number limit, or decline with a note (portal spec
 * §4.2; P2 decision 5). An admin page action, but not a fresh-passkey one:
 * spec §3 does not list it among the sensitive actions.
 */
export async function decideLimitAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireAdmin();
  const p = decideSchema.safeParse(Object.fromEntries(form.entries()));
  if (!p.success) return { ok: false, message: 'Choose a limit, or write a note to decline.' };
  const d = p.data;
  const r = decideLimitRequest(
    appCtx(),
    user.id,
    d.id,
    d.outcome === 'raised' ? { outcome: 'raised', limit: d.limit } : { outcome: 'declined', note: d.note },
    await requestMeta(),
  );
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath('/admin/limits');
  return { ok: true, message: d.outcome === 'raised' ? `Raised to ${d.limit}; they have been emailed.` : 'Declined; they have been emailed.' };
}
