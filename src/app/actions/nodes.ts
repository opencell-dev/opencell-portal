'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { FormState } from '@/app/actions/auth';
import { asFakeCore } from '@/core/fake';
import { AGREEMENT_VERSION } from '@/content/operator-agreement';
import { acceptAgreement, samePath } from '@/lib/agreement';
import { appCtx } from '@/lib/ctx';
import { addDowntime, askRetire, cancelDowntime, forgetSnapshot, myNodeRow, newSetupCommand, setAlertsMuted } from '@/lib/nodes/my-nodes';
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
  if (appCtx().config.site !== 'portal') redirect('/');
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

export type SetupCommandState = { ok: true; command: string; newKeyCommand: string; expiresAt: number; script: string; inspect: string } | { ok: false; message: string } | null;

/** "Make a new setup command": shown once, in the answer; the one before stops working. */
export async function newSetupCommandAction(_prev: SetupCommandState, form: FormData): Promise<SetupCommandState> {
  const { user } = await requireUser();
  const id = formId(form);
  if (id === null) return { ok: false, message: 'You have no such node.' };
  const r = newSetupCommand(appCtx(), user.id, id, await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath(`/nodes/${id}`);
  return r;
}

/** The alerts switch on a node. */
export async function setAlertsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  const id = formId(form);
  if (id === null) return { ok: false, message: 'You have no such node.' };
  const muted = form.get('muted') === '1';
  const r = setAlertsMuted(appCtx(), user.id, id, muted, await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath(`/nodes/${id}`);
  return { ok: true, message: muted ? 'Alerts are off for this node.' : 'Alerts are on for this node.' };
}

/** A downtime notice (portal spec §6.3): the form turns the reader's local times into unix ms. */
export async function addDowntimeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  const id = formId(form);
  if (id === null) return { ok: false, message: 'You have no such node.' };
  const r = addDowntime(appCtx(), user.id, id, { startsAt: form.get('startsAt'), endsAt: form.get('endsAt'), reason: form.get('reason') }, await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath(`/nodes/${id}`);
  return { ok: true, message: 'Posted. Alerts pause in that window, and the admins can see it.' };
}

export async function cancelDowntimeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  const id = formId(form);
  if (id === null) return { ok: false, message: 'You have no such notice.' };
  const r = cancelDowntime(appCtx(), user.id, id, await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath('/nodes', 'layout');
  return { ok: true, message: 'Cancelled.' };
}

/** "Tell the admins I'm retiring this node" (decision 24). */
export async function retireAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  const id = formId(form);
  if (id === null) return { ok: false, message: 'You have no such node.' };
  const r = askRetire(appCtx(), user.id, id, form.get('body'), await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  return { ok: true, message: 'The admins have been told. Thank you for hosting it.' };
}

/** The fake core only (development and the browser tests): the node's link comes up, or goes down. */
export async function simulateNodeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  const ctx = appCtx();
  if (ctx.config.core !== 'fake') return { ok: false, message: 'Simulation works only with the fake core.' };
  const id = formId(form);
  const n = id === null ? null : myNodeRow(ctx, user.id, id);
  const fake = n ? asFakeCore(ctx.cores.find((h) => h.id === n.coreId)?.core) : null;
  if (!n || !fake) return { ok: false, message: 'You have no such node.' };
  const online = form.get('online') === '1';
  fake.simCellOnline(n.cellId, online);
  forgetSnapshot(ctx, n.coreId);
  revalidatePath(`/nodes/${n.id}`);
  revalidatePath('/nodes');
  return { ok: true, message: online ? 'The simulated node is online.' : 'The simulated node is offline.' };
}
