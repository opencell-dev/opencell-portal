'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { appCtx } from '@/lib/ctx';
import { publicMessage } from '@/lib/errors';
import { findUserByEmail, grantRole } from '@/lib/users';
import { emailSchema } from '@/lib/validation';
import { freshAdmin } from '@/server/request';

export type AdminResult = { ok: true; message: string } | { ok: false; message: string } | { ok: false; reauth: true };

/** Promote an account to admin: a sensitive action, so it needs a fresh passkey (spec §3). */
export async function promoteAction(email: string): Promise<AdminResult> {
  const f = await freshAdmin();
  if (!f.ok) return f;
  const p = z.object({ email: emailSchema }).safeParse({ email });
  if (!p.success) return { ok: false, message: 'Please enter a valid email address.' };
  const ctx = appCtx();
  const u = findUserByEmail(ctx, p.data.email);
  if (!u?.emailVerifiedAt) return { ok: false, message: 'No verified account has that address.' };
  let added: boolean;
  try {
    added = grantRole(ctx, u.id, 'admin', f.s.user.id);
  } catch (e) {
    return { ok: false, message: publicMessage(e, 'That account could not be made an admin. Please try again.') };
  }
  if (!added) return { ok: true, message: `${u.email} is already an admin.` };
  revalidatePath('/admin/users');
  return { ok: true, message: `${u.email} is now an admin.` };
}
