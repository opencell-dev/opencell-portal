'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { AdminResult } from '@/app/actions/admin';
import { type AccountOutcome, disableAccount, enableAccount, setNumberDisabled } from '@/lib/admin/subscribers';
import { appCtx } from '@/lib/ctx';
import { publicMessage } from '@/lib/errors';
import { groupNumber } from '@/lib/noc/format';
import { getUser } from '@/lib/users';
import { freshAdmin, requestMeta } from '@/server/request';

// A subscriber's account and numbers (portal spec §3: disabling a subscriber
// needs a fresh passkey). The services refuse on the NOC site, which holds no
// subscribers: a server action can be posted to any page.

const idField = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const numberField = z.string().regex(/^\+8831\d{11}$/);

function outcome(r: AccountOutcome, done: string): AdminResult {
  if (!r.ok) return { ok: false, message: r.error };
  const failed = r.numbers.filter((n) => !n.ok);
  if (failed.length === 0) return { ok: true, message: done };
  return { ok: false, message: `${done} But the network didn't answer for ${failed.map((n) => groupNumber(n.number)).join(', ')}: run it again to finish them.` };
}

export async function disableAccountAction(id: number, confirmEmail: string): Promise<AdminResult> {
  const f = await freshAdmin();
  if (!f.ok) return f;
  const p = idField.safeParse(id);
  const email = z.string().max(1024).safeParse(confirmEmail);
  if (!p.success || !email.success) return { ok: false, message: 'No such account.' };
  const ctx = appCtx();
  if (ctx.config.site !== 'portal') return { ok: false, message: 'Subscribers are handled on the subscriber portal.' };
  const u = getUser(ctx, p.data);
  if (!u) return { ok: false, message: 'No such account.' };
  if (email.data.trim().toLowerCase() !== u.email) return { ok: false, message: 'Type the account’s email address exactly to confirm.' };
  try {
    const r = await disableAccount(ctx, f.s.user.id, p.data, await requestMeta());
    revalidatePath(`/admin/users/${p.data}`);
    return outcome(r, `${u.email} is disabled, and its numbers.`);
  } catch (e) {
    return { ok: false, message: publicMessage(e, 'That did not work. Please try again.') };
  }
}

export async function enableAccountAction(id: number): Promise<AdminResult> {
  const f = await freshAdmin();
  if (!f.ok) return f;
  const p = idField.safeParse(id);
  if (!p.success) return { ok: false, message: 'No such account.' };
  try {
    const r = await enableAccount(appCtx(), f.s.user.id, p.data, await requestMeta());
    revalidatePath(`/admin/users/${p.data}`);
    return outcome(r, 'The account is enabled, and the numbers its disabling stopped.');
  } catch (e) {
    return { ok: false, message: publicMessage(e, 'That did not work. Please try again.') };
  }
}

export async function numberDisabledAction(number: string, disabled: boolean): Promise<AdminResult> {
  const f = await freshAdmin();
  if (!f.ok) return f;
  const p = numberField.safeParse(number);
  const d = z.boolean().safeParse(disabled);
  if (!p.success || !d.success) return { ok: false, message: 'That is not a full OpenCell number.' };
  try {
    const r = await setNumberDisabled(appCtx(), f.s.user.id, p.data, d.data, await requestMeta());
    if (!r.ok) return { ok: false, message: r.error };
    revalidatePath('/admin/users', 'layout');
    return { ok: true, message: `${groupNumber(p.data)} is ${d.data ? 'disabled' : 'enabled'}.` };
  } catch (e) {
    return { ok: false, message: publicMessage(e, 'That did not work. Please try again.') };
  }
}
