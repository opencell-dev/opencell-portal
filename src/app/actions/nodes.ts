'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { FormState } from '@/app/actions/auth';
import { AGREEMENT_VERSION } from '@/content/operator-agreement';
import { acceptAgreement, samePath } from '@/lib/agreement';
import { appCtx } from '@/lib/ctx';
import { postMessage, submitRequest, withdrawRequest } from '@/lib/nodes/requests';
import { requestMeta, requireUser } from '@/server/request';

// The operator's actions (portal spec §6). Each checks the session itself
// first, and the services find a node or request among the session's own, so
// someone else's is "no such node", never a hint that it exists.

const idField = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function formId(form: FormData): number | null {
  const p = idField.safeParse(form.get('id'));
  return p.success ? p.data : null;
}

const field = (form: FormData, name: string) => form.get(name) ?? undefined;

/** "I accept" on /nodes/agreement: the current version, then on to where the sign-in was going. */
export async function acceptAgreementAction(form: FormData): Promise<void> {
  const { user } = await requireUser();
  acceptAgreement(appCtx(), user.id, AGREEMENT_VERSION, await requestMeta());
  const next = form.get('next');
  redirect(samePath(typeof next === 'string' ? next : '') ?? '/nodes');
}

/** "Send the request" (portal spec §6.1): on success, the request's own page. */
export async function submitRequestAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  const r = submitRequest(
    appCtx(),
    user.id,
    {
      siteName: field(form, 'siteName'),
      lat: field(form, 'lat'),
      lon: field(form, 'lon'),
      region: field(form, 'region'),
      piModel: field(form, 'piModel'),
      w12Boards: field(form, 'w12Boards'),
      gps: form.get('gps') === 'on',
      antenna: field(form, 'antenna'),
      backhaul: field(form, 'backhaul'),
      power: field(form, 'power'),
      contactPhone: field(form, 'contactPhone'),
      agree: form.get('agree') === 'on',
      agreementVersion: Number(form.get('agreementVersion')),
    },
    await requestMeta(),
  );
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath('/nodes');
  redirect(`/nodes/requests/${r.id}`);
}

export async function withdrawRequestAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  const id = formId(form);
  if (id === null) return { ok: false, message: 'You have no such request.' };
  const r = withdrawRequest(appCtx(), user.id, id, await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath(`/nodes/requests/${id}`);
  revalidatePath('/nodes');
  return { ok: true, message: 'Withdrawn.' };
}

/** The requester's reply in the thread. */
export async function replyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  const id = formId(form);
  if (id === null) return { ok: false, message: 'You have no such request.' };
  const r = postMessage(appCtx(), { requestId: id, authorId: user.id, fromAdmin: false, body: form.get('body') }, await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath(`/nodes/requests/${id}`);
  return { ok: true, message: 'Sent.' };
}
