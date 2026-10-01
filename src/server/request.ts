import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { appCtx } from '@/lib/ctx';
import { canUseAdmin, canUseNoc, isFresh, type RequestMeta, sessionFromToken } from '@/lib/sessions';
import { isAdmin, isStaff } from '@/lib/users';

// Request-level helpers for pages and server actions. Every page and every
// action that needs an account calls one of the require* functions itself:
// layouts are not a security boundary in the App Router.

export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return { ip: h.get('x-oc-client-ip') ?? 'unknown', userAgent: h.get('user-agent') ?? undefined };
}

export async function setSessionCookie(token: string, expiresAt: number): Promise<void> {
  const c = appCtx().config;
  (await cookies()).set(c.sessionCookie, token, {
    httpOnly: true,
    secure: c.secureCookies,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(appCtx().config.sessionCookie)?.value;
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(appCtx().config.sessionCookie);
}

export async function currentSession() {
  return sessionFromToken(appCtx(), await sessionToken());
}

/** The signed-in account, or a redirect to sign-in. */
export async function requireUser() {
  const s = await currentSession();
  if (!s) redirect('/sign-in');
  return s;
}

/**
 * An admin signed in with a passkey (spec §3); what everyone else gets:
 * - signed out: this calls notFound(), but on a page the (app) layout's
 *   requireUser has already redirected to /sign-in, so that is what they see;
 * - signed in without the admin role: a 404, so admin pages don't reveal themselves;
 * - an admin whose session can't use admin pages (email link, no user
 *   verification, or older than the 12 h admin window): a redirect to
 *   /sign-in?admin=1 to sign in with a passkey.
 * In a server action, the 404 or redirect reaches the client as a thrown call.
 */
export async function requireAdmin() {
  const s = await currentSession();
  const ctx = appCtx();
  if (s && !canUseAdmin(ctx, s.session) && isAdmin(ctx, s.user.id)) redirect('/sign-in?admin=1');
  if (!s || !canUseAdmin(ctx, s.session)) notFound();
  return s;
}

/**
 * A NOC page (NOC design §4): an admin or a NOC operator on a UV passkey
 * session (canUseNoc). Everyone else as requireAdmin: signed out or not
 * staff, a 404; staff whose session can't open the NOC, a redirect to
 * /sign-in?noc=1 to sign in with a passkey.
 */
export async function requireNoc() {
  const s = await currentSession();
  const ctx = appCtx();
  if (s && !canUseNoc(ctx, s.session) && isStaff(ctx, s.user.id)) redirect('/sign-in?noc=1');
  if (!s || !canUseNoc(ctx, s.session)) notFound();
  return s;
}

/** For sensitive admin actions: the session must hold a passkey assertion from the last 5 minutes. */
export async function freshAdmin(): Promise<{ ok: true; s: Awaited<ReturnType<typeof requireAdmin>> } | { ok: false; reauth: true }> {
  const s = await requireAdmin();
  return isFresh(appCtx(), s.session) ? { ok: true, s } : { ok: false, reauth: true };
}
