'use server';

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { consumeEmailToken, requestMagicLink, signUp } from '@/lib/accounts';
import { appCtx } from '@/lib/ctx';
import { publicMessage } from '@/lib/errors';
import {
  finishReauth,
  finishRegistration,
  finishSignIn,
  NeedsReauth,
  reauthOptions,
  registrationOptions,
  signInOptions,
} from '@/lib/passkeys';
import { SESSION_MS } from '@/lib/sessions';
import { ADMIN_SESSION_MS, isStaff, STAFF_ONLY } from '@/lib/users';
import { firstError, optionalPasskeyNameSchema, passkeyTransportsSchema } from '@/lib/validation';
import { currentSession, requestMeta, requireUser, setSessionCookie } from '@/server/request';

export type FormState = { ok: boolean; message: string } | null;

// What the browser sends back from WebAuthn: checked for shape here, and in
// full by SimpleWebAuthn.
const challengeId = z.string().min(20).max(64);
const credential = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: z.string().max(4096) }),
  clientExtensionResults: z.looseObject({}),
});
// A new passkey also reports its transports: known values only, bounded.
const attestation = credential.extend({
  response: z.looseObject({ clientDataJSON: z.string().max(4096), transports: passkeyTransportsSchema.optional() }),
});
const asAssertion = (v: unknown) => credential.parse(v) as unknown as AuthenticationResponseJSON;
const asAttestation = (v: unknown) => attestation.parse(v) as unknown as RegistrationResponseJSON;

function cookieExpiry(userId: number): number {
  const ctx = appCtx();
  return ctx.now() + (isStaff(ctx, userId) ? ADMIN_SESSION_MS : SESSION_MS);
}

export async function signUpAction(_prev: FormState, form: FormData): Promise<FormState> {
  const r = await signUp(
    appCtx(),
    { name: form.get('name') ?? '', email: form.get('email') ?? '', altcha: form.get('altcha') ?? '' },
    await requestMeta(),
  );
  return r.ok
    ? { ok: true, message: 'Check your inbox: we sent you a link. It works for 30 minutes.' }
    : { ok: false, message: r.error };
}

export async function magicLinkAction(_prev: FormState, form: FormData): Promise<FormState> {
  const r = await requestMagicLink(appCtx(), { email: form.get('email') ?? '' }, await requestMeta());
  return r.ok
    ? { ok: true, message: 'If that address has an account, a sign-in link is on its way. It works for 15 minutes.' }
    : { ok: false, message: r.error };
}

/**
 * The confirm button on /auth/email/[token]: the link is used only when a
 * person clicks. On the NOC's site (NOC design §N1.5) every link leads to
 * Account: an added account adds its passkey there, and staff open the NOC
 * only with a passkey sign-in anyway.
 */
export async function confirmEmailLinkAction(token: string): Promise<void> {
  const nocSite = appCtx().config.site === 'noc';
  const r = await consumeEmailToken(appCtx(), z.string().max(64).parse(token), await requestMeta());
  if (!r.ok) {
    if (r.error === STAFF_ONLY) redirect('/sign-in?staff=1');
    // A second press (double click, or a retry after the first went through)
    // finds the link used; if this browser is already signed in, carry on.
    if (await currentSession()) redirect(nocSite ? '/account' : '/numbers');
    redirect(`/auth/email/${encodeURIComponent(token)}`);
  }
  if (r.sessionToken) await setSessionCookie(r.sessionToken, cookieExpiry(r.userId));
  if (r.purpose === 'email_change') redirect('/account?email=changed');
  if (nocSite) redirect('/account');
  if (r.purpose === 'verify') redirect('/welcome');
  redirect('/numbers');
}

export async function passkeySignInStart() {
  return signInOptions(appCtx(), await requestMeta());
}

export async function passkeySignInFinish(id: string, response: AuthenticationResponseJSON) {
  const r = await finishSignIn(appCtx(), challengeId.parse(id), asAssertion(response), await requestMeta());
  if (!r.ok) return { ok: false as const, error: r.error };
  await setSessionCookie(r.sessionToken, cookieExpiry(r.userId));
  return { ok: true as const };
}

/**
 * Options for a new passkey. An admin whose passkey session isn't freshly
 * confirmed gets `{ reauth: true }`: the page asks for the passkey
 * (reauthenticate()) and tries once more.
 */
export async function passkeyRegisterStart() {
  const { session } = await requireUser();
  try {
    return { ok: true as const, ...(await registrationOptions(appCtx(), session)) };
  } catch (e) {
    if (e instanceof NeedsReauth) return { ok: false as const, reauth: true as const, error: e.message };
    return { ok: false as const, error: publicMessage(e, 'Adding a passkey did not work. Please try again.') };
  }
}

export async function passkeyRegisterFinish(id: string, response: RegistrationResponseJSON, name: string) {
  const { session } = await requireUser();
  const label = optionalPasskeyNameSchema.safeParse(name);
  if (!label.success) return { ok: false as const, error: firstError(label.error) };
  const r = await finishRegistration(
    appCtx(),
    session,
    challengeId.parse(id),
    asAttestation(response),
    label.data,
    await requestMeta(),
  );
  if (r.ok) return { ok: true as const };
  return 'reauth' in r ? { ok: false as const, reauth: true as const, error: r.error } : { ok: false as const, error: r.error };
}

export async function reauthStart() {
  const { session } = await requireUser();
  return reauthOptions(appCtx(), session);
}

export async function reauthFinish(id: string, response: AuthenticationResponseJSON) {
  const { session } = await requireUser();
  const r = await finishReauth(appCtx(), session, challengeId.parse(id), asAssertion(response), await requestMeta());
  return r.ok ? { ok: true as const } : { ok: false as const, error: r.error };
}
