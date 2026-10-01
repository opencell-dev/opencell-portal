import { createHmac } from 'node:crypto';
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, eq } from 'drizzle-orm';
import { challenges, passkeys, sessions } from '@/db/schema';
import type { Result } from '@/lib/accounts';
import { writeAudit } from '@/lib/audit';
import { UserError } from '@/lib/errors';
import type { Ctx } from '@/lib/ctx';
import { hitIp } from '@/lib/ratelimit';
import { createSession, isFresh, markReauth, type RequestMeta, type Session } from '@/lib/sessions';
import { newToken } from '@/lib/tokens';
import { getUser, isAdmin, isStaff, STAFF_ONLY, siteAdmits } from '@/lib/users';
import { firstError, optionalPasskeyNameSchema, passkeyTransportsSchema } from '@/lib/validation';

// Passkeys (spec §3) with SimpleWebAuthn: discoverable credentials, so sign-in
// needs no email; "none" attestation; user verification preferred, except
// where an admin session is at stake (re-auth, always; sign-in and
// registration for an admin account), where it's required.

const CHALLENGE_MS = 5 * 60_000;
type Purpose = 'register' | 'signin' | 'reauth';

export type Passkey = typeof passkeys.$inferSelect;

/** A short, log-friendly prefix of a credential id, for audit details. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

function isConstraintError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT');
}

function saveChallenge(ctx: Ctx, purpose: Purpose, challenge: string, userId: number | null, sessionId: string | null): string {
  const id = newToken();
  ctx.db.insert(challenges).values({ id, purpose, userId, sessionId, challenge, expiresAt: ctx.now() + CHALLENGE_MS }).run();
  return id;
}

/**
 * Take a challenge out of the table (single use); null if missing, expired,
 * of another kind, or not issued to this user's own session.
 */
function takeChallenge(ctx: Ctx, id: string, purpose: Purpose, userId: number | null, sessionId: string | null): string | null {
  const row = ctx.db.select().from(challenges).where(eq(challenges.id, id)).get();
  if (!row) return null;
  ctx.db.delete(challenges).where(eq(challenges.id, id)).run();
  if (row.purpose !== purpose || row.expiresAt <= ctx.now() || row.userId !== userId || row.sessionId !== sessionId) return null;
  return row.challenge;
}

/** A stable, opaque WebAuthn user handle (no email or id in it). */
/**
 * The WebAuthn user handle for an account. Both sites use the RP ID
 * opencell.k4ozi.com (NOC design §N1.5), and an authenticator replaces a
 * passkey whose RP ID and user handle match a new one: the NOC's handles
 * are derived apart, so registering on one site never replaces the
 * person's passkey for the other, even if the two shared OC_SECRET. The
 * portal's derivation is unchanged (its passkeys check against it).
 */
function userHandle(ctx: Ctx, userId: number): Uint8Array<ArrayBuffer> {
  const label = ctx.config.site === 'noc' ? `user-handle:noc:${userId}` : `user-handle:${userId}`;
  return new Uint8Array(createHmac('sha256', ctx.config.secret).update(label).digest().subarray(0, 16));
}

/** Staff passkeys need user verification; on the NOC's site, every passkey does (canUseNoc needs a UV session). */
function needsUv(ctx: Ctx, userId: number): boolean {
  return ctx.config.site === 'noc' || isStaff(ctx, userId);
}

function userHandleB64(ctx: Ctx, userId: number): string {
  return Buffer.from(userHandle(ctx, userId)).toString('base64url');
}

function transportsOf(p: Passkey): AuthenticatorTransport[] | undefined {
  return p.transports ? (JSON.parse(p.transports) as AuthenticatorTransport[]) : undefined;
}

export function listPasskeys(ctx: Ctx, userId: number): Passkey[] {
  return ctx.db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();
}

/** The session's current row, not the possibly-stale snapshot a caller is holding. */
function currentSession(ctx: Ctx, id: string): Session | undefined {
  return ctx.db.select().from(sessions).where(eq(sessions.id, id)).get();
}

/**
 * Thrown by registrationOptions when an admin's passkey session needs a fresh
 * assertion first: the browser can get one (reauthenticate()) and retry.
 */
export class NeedsReauth extends UserError {
  override name = 'NeedsReauth';
}

/** "Confirm with your passkey, then try again": the answer the account page acts on. */
export type NeedsFreshPasskey = { ok: false; reauth: true; error: string };

const SIGN_IN_WITH_PASSKEY = 'Staff sign in with a passkey, not an email link, before changing passkeys.';
const CONFIRM_FRESH = 'Staff confirm with a fresh passkey before changing passkeys.';

/**
 * Staff (admins, NOC operators) change passkeys only from a passkey session confirmed (with UV) in
 * the last 5 minutes. Null when this session may; otherwise why not. Only a
 * passkey session can be confirmed again (finishReauth refuses the others),
 * so only that refusal carries `reauth`.
 */
function passkeyChangeRefusal(ctx: Ctx, s: Session): NeedsFreshPasskey | { ok: false; error: string } | null {
  if (!isStaff(ctx, s.userId)) return null;
  if (s.method !== 'passkey') return { ok: false, error: SIGN_IN_WITH_PASSKEY };
  if (!isFresh(ctx, s)) return { ok: false, reauth: true, error: CONFIRM_FRESH };
  return null;
}

export async function registrationOptions(ctx: Ctx, s: Session) {
  const u = getUser(ctx, s.userId);
  if (!u?.emailVerifiedAt) throw new UserError('Only a verified account can add a passkey.');
  const refusal = passkeyChangeRefusal(ctx, s);
  if (refusal) throw 'reauth' in refusal ? new NeedsReauth(refusal.error) : new UserError(refusal.error);
  const uv = needsUv(ctx, u.id);
  const options = await generateRegistrationOptions({
    rpName: 'OpenCell',
    rpID: ctx.config.rpId,
    // Both sites share the RP ID (NOC design §N1.5): the NOC's passkey says so, for the browser's picker.
    userName: ctx.config.site === 'noc' ? `${u.email} (OpenCell NOC)` : u.email,
    userDisplayName: ctx.config.site === 'noc' ? `${u.name} (OpenCell NOC)` : u.name,
    userID: userHandle(ctx, u.id),
    attestationType: 'none',
    excludeCredentials: listPasskeys(ctx, u.id).map((p) => ({ id: p.id, transports: transportsOf(p) })),
    authenticatorSelection: { residentKey: 'required', userVerification: uv ? 'required' : 'preferred' },
  });
  return { challengeId: saveChallenge(ctx, 'register', options.challenge, u.id, s.id), options };
}

export async function finishRegistration(
  ctx: Ctx,
  s: Session,
  challengeId: string,
  response: RegistrationResponseJSON,
  name: string | undefined,
  meta: RequestMeta,
): Promise<Result<{ credentialId: string }> | NeedsFreshPasskey> {
  // Client-supplied, so checked before anything else (and before the
  // challenge is used, so a bad name can be corrected and sent again).
  const label = optionalPasskeyNameSchema.safeParse(name);
  if (!label.success) return { ok: false, error: firstError(label.error) };
  const transports = passkeyTransportsSchema.optional().safeParse(response.response?.transports);
  if (!transports.success) return { ok: false, error: 'The passkey could not be checked. Please try again.' };
  response = { ...response, response: { ...response.response, transports: transports.data } };
  const expectedChallenge = takeChallenge(ctx, challengeId, 'register', s.userId, s.id);
  if (!expectedChallenge) return { ok: false, error: 'The passkey request expired. Please try again.' };
  // Re-check: time may have passed between requesting and finishing the options,
  // against the session's current row, not the caller's possibly-stale copy.
  const u = getUser(ctx, s.userId);
  if (!u?.emailVerifiedAt) return { ok: false, error: 'Only a verified account can add a passkey.' };
  const live = currentSession(ctx, s.id);
  if (!live) return { ok: false, error: 'The passkey request expired. Please try again.' };
  const refusal = passkeyChangeRefusal(ctx, live);
  if (refusal) return refusal;
  const uv = needsUv(ctx, s.userId);
  let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ctx.config.origin,
      expectedRPID: ctx.config.rpId,
      requireUserVerification: uv,
    });
  } catch {
    return { ok: false, error: 'The passkey could not be checked. Please try again.' };
  }
  if (!v.verified || !v.registrationInfo) return { ok: false, error: 'The passkey could not be checked. Please try again.' };
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  try {
    ctx.db
      .insert(passkeys)
      .values({
        id: credential.id,
        userId: s.userId,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ? JSON.stringify(credential.transports) : null,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        name: label.data ?? 'Passkey',
        createdAt: ctx.now(),
      })
      .run();
  } catch (e) {
    if (isConstraintError(e)) return { ok: false, error: 'This passkey is already registered.' };
    throw e;
  }
  writeAudit(ctx, { actorId: s.userId, action: 'passkey.add', target: `user:${s.userId}`, detail: { credentialId: shortId(credential.id) }, ip: meta.ip });
  return { ok: true, credentialId: credential.id };
}

/**
 * Options for a discoverable sign-in. Anyone may ask, and each answer is a
 * stored challenge, so starts are limited per client address like the other
 * sign-in and sign-up entry points (spec §3).
 */
export async function signInOptions(ctx: Ctx, meta: RequestMeta) {
  const lim = hitIp(ctx, 'signin_ip', meta.ip);
  if (!lim.ok) return { ok: false as const, error: lim.message };
  const options = await generateAuthenticationOptions({ rpID: ctx.config.rpId, userVerification: 'preferred' });
  return { ok: true as const, challengeId: saveChallenge(ctx, 'signin', options.challenge, null, null), options };
}

interface AssertionResult {
  userVerified: boolean;
}

/**
 * Verify an assertion against a known passkey, update its counter and
 * device metadata, and audit a counter regression (a signal of possible
 * cloning) as its own event. Null on any failure.
 */
async function checkAssertion(
  ctx: Ctx,
  p: Passkey,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  requireUV: boolean,
  meta: RequestMeta,
): Promise<AssertionResult | null> {
  let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ctx.config.origin,
      expectedRPID: ctx.config.rpId,
      credential: { id: p.id, publicKey: new Uint8Array(p.publicKey), counter: p.counter, transports: transportsOf(p) },
      requireUserVerification: requireUV,
    });
  } catch (e) {
    // SimpleWebAuthn checks the counter before the signature, so a forged
    // assertion (correct credential id, junk signature, counter reset to 0 —
    // no private key needed) hits this same error. Re-verify with the
    // counter check disabled, so only the signature is tested; audit a
    // regression only once that passes. Either way, this sign-in still fails.
    if (e instanceof Error && /counter value/i.test(e.message)) {
      try {
        const v2 = await verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: ctx.config.origin,
          expectedRPID: ctx.config.rpId,
          credential: { id: p.id, publicKey: new Uint8Array(p.publicKey), counter: 0, transports: transportsOf(p) },
          requireUserVerification: requireUV,
        });
        if (v2.verified) {
          writeAudit(ctx, {
            actorId: p.userId,
            action: 'passkey.counter_regression',
            target: `user:${p.userId}`,
            detail: { credentialId: shortId(p.id) },
            ip: meta.ip,
          });
        }
      } catch {
        // Signature also failed to verify: a forged assertion, not a genuine regression.
      }
    }
    return null;
  }
  if (!v.verified) return null;
  // A discoverable credential names its account; refuse a mismatch.
  if (response.response.userHandle && response.response.userHandle !== userHandleB64(ctx, p.userId)) return null;
  const { newCounter, credentialDeviceType, credentialBackedUp, userVerified } = v.authenticationInfo;
  ctx.db
    .update(passkeys)
    .set({ counter: newCounter, lastUsedAt: ctx.now(), deviceType: credentialDeviceType, backedUp: credentialBackedUp })
    .where(eq(passkeys.id, p.id))
    .run();
  return { userVerified };
}

export async function finishSignIn(
  ctx: Ctx,
  challengeId: string,
  response: AuthenticationResponseJSON,
  meta: RequestMeta,
): Promise<Result<{ userId: number; sessionToken: string }>> {
  const expectedChallenge = takeChallenge(ctx, challengeId, 'signin', null, null);
  if (!expectedChallenge) return { ok: false, error: 'The passkey request expired. Please try again.' };
  const p = ctx.db.select().from(passkeys).where(eq(passkeys.id, String(response.id))).get();
  if (!p) return { ok: false, error: 'This passkey is not registered here.' };
  // Sign-in doesn't demand UV up front (subscribers may not have it configured); an
  // admin session from a non-UV assertion is simply not admin-capable (see sessions.ts).
  const check = await checkAssertion(ctx, p, response, expectedChallenge, false, meta);
  if (!check) return { ok: false, error: 'The passkey could not be checked. Please try again.' };
  // The NOC's site signs in staff only (NOC design §N1.5).
  if (!siteAdmits(ctx, p.userId)) return { ok: false, error: STAFF_ONLY };
  const { token } = createSession(ctx, p.userId, 'passkey', meta, { uv: check.userVerified, credentialId: p.id });
  writeAudit(ctx, { actorId: p.userId, action: 'session.passkey', target: `user:${p.userId}`, ip: meta.ip });
  return { ok: true, userId: p.userId, sessionToken: token };
}

/** A fresh assertion for sensitive admin actions, limited to this account's passkeys. */
export async function reauthOptions(ctx: Ctx, s: Session) {
  const options = await generateAuthenticationOptions({
    rpID: ctx.config.rpId,
    userVerification: 'required',
    allowCredentials: listPasskeys(ctx, s.userId).map((p) => ({ id: p.id, transports: transportsOf(p) })),
  });
  return { challengeId: saveChallenge(ctx, 'reauth', options.challenge, s.userId, s.id), options };
}

export async function finishReauth(
  ctx: Ctx,
  s: Session,
  challengeId: string,
  response: AuthenticationResponseJSON,
  meta: RequestMeta,
): Promise<Result> {
  if (s.method !== 'passkey') return { ok: false, error: 'Re-authentication needs a passkey session.' };
  const expectedChallenge = takeChallenge(ctx, challengeId, 'reauth', s.userId, s.id);
  if (!expectedChallenge) return { ok: false, error: 'The passkey request expired. Please try again.' };
  const p = ctx.db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.id, String(response.id)), eq(passkeys.userId, s.userId)))
    .get();
  if (!p) return { ok: false, error: 'Use a passkey of this account.' };
  const check = await checkAssertion(ctx, p, response, expectedChallenge, true, meta);
  if (!check) return { ok: false, error: 'The passkey could not be checked. Please try again.' };
  markReauth(ctx, s.id);
  writeAudit(ctx, { actorId: s.userId, action: 'session.reauth', target: `user:${s.userId}`, ip: meta.ip });
  return { ok: true };
}

export function removePasskey(ctx: Ctx, s: Session, passkeyId: string, meta: RequestMeta): Result | NeedsFreshPasskey {
  const refusal = passkeyChangeRefusal(ctx, s);
  if (refusal) return refusal;
  const own = listPasskeys(ctx, s.userId);
  const target = own.find((p) => p.id === passkeyId);
  if (!target) return { ok: false, error: 'No such passkey.' };
  if (isStaff(ctx, s.userId) && own.length <= 1) {
    return { ok: false, error: isAdmin(ctx, s.userId) ? 'Admins need at least one passkey.' : 'NOC operators need at least one passkey.' };
  }
  ctx.db.delete(passkeys).where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, s.userId))).run();
  // The credential is gone: any session it opened is no longer backed by anything real.
  ctx.db.delete(sessions).where(eq(sessions.credentialId, passkeyId)).run();
  writeAudit(ctx, { actorId: s.userId, action: 'passkey.remove', target: `user:${s.userId}`, detail: { credentialId: shortId(passkeyId) }, ip: meta.ip });
  return { ok: true };
}
