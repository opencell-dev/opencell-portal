'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { appCtx } from '@/lib/ctx';
import { publicMessage } from '@/lib/errors';
import { listPasskeys } from '@/lib/passkeys';
import { findUserByEmail, grantRole, revokeRole, rolesOf } from '@/lib/users';
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
  // The NOC's site (NOC design §N1.5), as for the NOC role (review I3): staff cannot add a first passkey.
  if (ctx.config.site === 'noc' && listPasskeys(ctx, u.id).length === 0) {
    return { ok: false, message: `${u.email} has no passkey yet: ask them to add one on Account first.` };
  }
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

/**
 * Make an account a NOC operator, or take the role away (NOC design §4): a
 * role change, so it needs a fresh passkey, like promoting an admin.
 */
export async function nocRoleAction(email: string, grant: boolean): Promise<AdminResult> {
  const f = await freshAdmin();
  if (!f.ok) return f;
  const ctx = appCtx();
  // NOC design §N1.5: the NOC has its own site and accounts.
  if (ctx.config.site !== 'noc') return { ok: false, message: 'NOC roles are given on the NOC site.' };
  const p = z.object({ email: emailSchema, grant: z.boolean() }).safeParse({ email, grant });
  if (!p.success) return { ok: false, message: 'Please enter a valid email address.' };
  const u = findUserByEmail(ctx, p.data.email);
  if (!u?.emailVerifiedAt) return { ok: false, message: 'No verified account has that address.' };
  if (!p.data.grant) {
    if (!rolesOf(ctx, u.id).includes('noc')) return { ok: true, message: `${u.email} is not a NOC operator.` };
    revokeRole(ctx, u.id, 'noc', f.s.user.id);
    revalidatePath('/admin/users');
    return { ok: true, message: `${u.email} is no longer a NOC operator.` };
  }
  // Review I3: granting the role to an account with no passkey strands it —
  // the NOC redirects it to a passkey sign-in it cannot complete, and
  // registering a passkey as staff itself needs a passkey session to confirm.
  if (listPasskeys(ctx, u.id).length === 0) {
    return { ok: false, message: `${u.email} has no passkey yet: ask them to add one on Account first.` };
  }
  let added: boolean;
  try {
    added = grantRole(ctx, u.id, 'noc', f.s.user.id);
  } catch (e) {
    return { ok: false, message: publicMessage(e, 'That account could not be made a NOC operator. Please try again.') };
  }
  if (!added) return { ok: true, message: `${u.email} is already a NOC operator.` };
  revalidatePath('/admin/users');
  return { ok: true, message: `${u.email} is now a NOC operator.` };
}
