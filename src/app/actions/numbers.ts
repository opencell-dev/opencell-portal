'use server';

import { randomInt } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { FormState } from '@/app/actions/auth';
import { asFakeCore } from '@/core/fake';
import { writeAudit } from '@/lib/audit';
import { appCtx } from '@/lib/ctx';
import { activationQrMail } from '@/lib/mail-templates';
import { activateHref } from '@/lib/numbers/format';
import { getNumber, numberOf, releaseNumber, reissueNumber, syncNumber } from '@/lib/numbers/ownership';
import { takeQr } from '@/lib/numbers/qr-flash';
import { coreFor } from '@/lib/numbers/route';
import { hit } from '@/lib/ratelimit';
import { requestMeta, requireUser } from '@/server/request';

// The number actions (portal spec §4.1, §5 My numbers). Each takes a form,
// so it works without JavaScript too (useActionState), checks the session
// itself first, and finds the number among the session's own: another
// account's number is "no such number", never a hint that it exists.

const numberField = z.string().regex(/^\+8831\d{11}$/);

function formNumber(form: FormData): string | null {
  const p = numberField.safeParse(form.get('number'));
  return p.success ? p.data : null;
}

/** "Get this number" on the confirm step: on success, the activation page. */
export async function getNumberAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { session } = await requireUser();
  const r = await getNumber(appCtx(), session, { number: form.get('number'), listed: form.get('listed') }, await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath('/numbers');
  redirect(activateHref(r.token.number));
}

/** A new QR (re-issue / move to a new terminal): the old token stops working. */
export async function reissueAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { session } = await requireUser();
  const number = formNumber(form);
  if (!number) return { ok: false, message: 'You have no such number.' };
  const r = await reissueNumber(appCtx(), session, number, await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath('/numbers');
  redirect(activateHref(number));
}

/** Give back an unactivated number. */
export async function releaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { session } = await requireUser();
  const number = formNumber(form);
  if (!number) return { ok: false, message: 'You have no such number.' };
  const r = await releaseNumber(appCtx(), session, number, await requestMeta());
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath('/numbers');
  return { ok: true, message: 'Released: the number is back in the pool.' };
}

/** "Email it to me": the QR's text form to the account's own address, while the flash still holds it. */
export async function emailQrAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { session, user } = await requireUser();
  const ctx = appCtx();
  const number = formNumber(form);
  if (!number || !numberOf(ctx, user.id, number)) return { ok: false, message: 'You have no such number.' };
  const t = takeQr(session.id, number, ctx.now());
  if (!t) return { ok: false, message: 'This QR code is no longer here (it is kept for 15 minutes). Make a new one.' };
  const lim = hit(ctx, 'qr_mail_account', String(user.id));
  if (!lim.ok) return { ok: false, message: lim.message };
  const m = activationQrMail(user.name, number, t.qr, t.expiresAt, ctx.config.origin);
  ctx.mailQueue.send({ to: user.email, subject: m.subject, text: m.text });
  writeAudit(ctx, { actorId: user.id, action: 'number.qr_mail', target: `number:${number}`, ip: (await requestMeta()).ip });
  return { ok: true, message: `Sent to ${user.email}.` };
}

/**
 * Development and tests only (OC_CORE=fake): play the terminal and the cell
 * for one of your numbers, so the card's live status can be seen moving
 * (spec §13: "sub.status flips when a simulated terminal activates"). A no-op
 * with a real core, which production always has.
 */
export async function simulateAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { session, user } = await requireUser();
  const ctx = appCtx();
  if (ctx.config.core !== 'fake') return { ok: false, message: 'Simulation works only with the fake core.' };
  const number = formNumber(form);
  const row = number ? numberOf(ctx, user.id, number) : undefined;
  const fake = number ? asFakeCore(coreFor(ctx, number).core) : null;
  if (!number || !row || !fake) return { ok: false, message: 'You have no such number.' };
  const op = z.enum(['activate', 'register']).safeParse(form.get('op'));
  if (!op.success) return { ok: false, message: 'Not a simulation.' };
  try {
    if (op.data === 'activate') {
      const t = takeQr(session.id, number, ctx.now());
      if (!t) return { ok: false, message: 'The QR code is no longer here: make a new one first.' };
      fake.simActivate(t.qr, randomInt(1, 0x7fffffff));
    } else {
      const cell = fake.simCells().find((c) => !c.revoked)?.cellId ?? fake.simAddCell('Bench cell', 'part15', 1);
      fake.simRegister(number, cell);
    }
  } catch (e) {
    return { ok: false, message: `The fake core said no: ${(e as Error).message}` };
  }
  await syncNumber(ctx, row);
  revalidatePath('/numbers');
  return { ok: true, message: op.data === 'activate' ? 'A simulated terminal activated it.' : 'Registered on a simulated cell.' };
}
