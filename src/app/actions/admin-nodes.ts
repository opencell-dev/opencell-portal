'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { FormState } from '@/app/actions/auth';
import { appCtx } from '@/lib/ctx';
import { publicMessage } from '@/lib/errors';
import { postMessage } from '@/lib/nodes/requests';
import { approveRequest, declineRequest } from '@/lib/nodes/review';
import { freshAdmin, requestMeta, requireAdmin } from '@/server/request';

// The review (portal spec §6.2). Approving is a sensitive action: a fresh
// passkey (spec §3). Declining and asking change nothing on the network.

export type ApproveResult = { ok: true; message: string; nodeId: number } | { ok: false; message: string } | { ok: false; reauth: true };

const idField = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export async function approveAction(id: number, opts: unknown): Promise<ApproveResult> {
  const f = await freshAdmin();
  if (!f.ok) return f;
  const p = idField.safeParse(id);
  if (!p.success) return { ok: false, message: 'No such request.' };
  try {
    const r = await approveRequest(appCtx(), f.s.user.id, p.data, opts, await requestMeta());
    if (!r.ok) return { ok: false, message: r.error };
    revalidatePath('/admin/requests');
    return {
      ok: true,
      nodeId: r.nodeId,
      message: r.tokenMade ? `Approved: cell ${r.cellId}. The operator has been mailed the setup command.` : `Approved: cell ${r.cellId}. No release is published yet, so setup opens when one is.`,
    };
  } catch (e) {
    return { ok: false, message: publicMessage(e, 'Approving did not work. Please try again.') };
  }
}

export async function declineAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireAdmin();
  const id = idField.safeParse(form.get('id'));
  if (!id.success) return { ok: false, message: 'No such request.' };
  const r = declineRequest(appCtx(), user.id, id.data, form.get('body'), await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath('/admin/requests');
  return { ok: true, message: 'Declined; they have been emailed.' };
}

export async function askAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireAdmin();
  const id = idField.safeParse(form.get('id'));
  if (!id.success) return { ok: false, message: 'No such request.' };
  const r = postMessage(appCtx(), { requestId: id.data, authorId: user.id, fromAdmin: true, body: form.get('body') }, await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath(`/admin/requests/${id.data}`);
  return { ok: true, message: 'Sent; they have been emailed.' };
}
