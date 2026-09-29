'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { FormState } from '@/app/actions/auth';
import { changeEmail, deleteAccount, type NumberChoice, setDirectoryListed } from '@/lib/accounts';
import { appCtx } from '@/lib/ctx';
import { removePasskey } from '@/lib/passkeys';
import { clearSessionCookie, requestMeta, requireUser } from '@/server/request';

export async function changeEmailAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  const r = await changeEmail(appCtx(), user.id, { email: form.get('email') ?? '' });
  return r.ok
    ? { ok: true, message: 'We sent a link to the new address. Your email changes when you open it (within 30 minutes).' }
    : { ok: false, message: r.error };
}

export async function setDirectoryAction(form: FormData): Promise<void> {
  const { user } = await requireUser();
  const listed = z.enum(['0', '1']).parse(form.get('listed')) === '1';
  setDirectoryListed(appCtx(), user.id, listed, await requestMeta());
  redirect('/account');
}

export async function removePasskeyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { session } = await requireUser();
  const id = z.string().min(1).max(1024).parse(form.get('id'));
  const r = removePasskey(appCtx(), session, id, await requestMeta());
  revalidatePath('/account');
  return r.ok ? { ok: true, message: 'Passkey removed.' } : { ok: false, message: r.error };
}

export async function deleteAccountAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  const choices: Record<string, NumberChoice> = {};
  for (const [k, v] of form.entries()) {
    if (k.startsWith('choice:') && (v === 'keep' || v === 'disable')) choices[k.slice(7)] = v;
  }
  const r = await deleteAccount(
    appCtx(),
    user.id,
    { confirmEmail: String(form.get('confirmEmail') ?? ''), choices },
    await requestMeta(),
  );
  if (!r.ok) return { ok: false, message: r.error };
  await clearSessionCookie();
  redirect('/?deleted=1');
}
