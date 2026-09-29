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
import { challenges, passkeys } from '@/db/schema';
import type { Result } from '@/lib/accounts';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { createSession, isFresh, markReauth, type RequestMeta, type Session } from '@/lib/sessions';
import { newToken } from '@/lib/tokens';
import { getUser, isAdmin } from '@/lib/users';

// Passkeys (spec §3) with SimpleWebAuthn: discoverable credentials, so sign-in
// needs no email; "none" attestation; user verification preferred.

const CHALLENGE_MS = 5 * 60_000;
type Purpose = 'register' | 'signin' | 'reauth';

export type Passkey = typeof passkeys.$inferSelect;

function saveChallenge(ctx: Ctx, purpose: Purpose, challenge: string, userId: number | null): string {
  const id = newToken();
  ctx.db.insert(challenges).values({ id, purpose, userId, challenge, expiresAt: ctx.now() + CHALLENGE_MS }).run();
  return id;
}

/** Take a challenge out of the table (single use); null if missing, expired or of another kind. */
function takeChallenge(ctx: Ctx, id: string, purpose: Purpose, userId: number | null): string | null {
  const row = ctx.db.select().from(challenges).where(eq(challenges.id, id)).get();
  if (!row) return null;
  ctx.db.delete(challenges).where(eq(challenges.id, id)).run();
  if (row.purpose !== purpose || row.expiresAt <= ctx.now() || row.userId !== userId) return null;
  return row.challenge;
}

/** A stable, opaque WebAuthn user handle (no email or id in it). */
function userHandle(ctx: Ctx, userId: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHmac('sha256', ctx.config.secret).update(`user-handle:${userId}`).digest().subarray(0, 16));
}

function transportsOf(p: Passkey): AuthenticatorTransport[] | undefined {
  return p.transports ? (JSON.parse(p.transports) as AuthenticatorTransport[]) : undefined;
}

export function listPasskeys(ctx: Ctx, userId: number): Passkey[] {
  return ctx.db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();
}

/** Admins change passkeys only from a passkey session confirmed in the last 5 minutes. */
function mayChangePasskeys(ctx: Ctx, s: Session): boolean {
  return !isAdmin(ctx, s.userId) || (s.method === 'passkey' && isFresh(ctx, s));
}

export async function registrationOptions(ctx: Ctx, s: Session) {
  const u = getUser(ctx, s.userId);
  if (!u?.emailVerifiedAt) throw new Error('Only a verified account can add a passkey.');
  if (!mayChangePasskeys(ctx, s)) throw new Error('Admins confirm with a fresh passkey before adding one.');
  const options = await generateRegistrationOptions({
    rpName: 'OpenCell',
    rpID: ctx.config.rpId,
    userName: u.email,
    userDisplayName: u.name,
    userID: userHandle(ctx, u.id),
    attestationType: 'none',
    excludeCredentials: listPasskeys(ctx, u.id).map((p) => ({ id: p.id, transports: transportsOf(p) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  return { challengeId: saveChallenge(ctx, 'register', options.challenge, u.id), options };
}

export async function finishRegistration(
  ctx: Ctx,
  s: Session,
  challengeId: string,
  response: RegistrationResponseJSON,
  name: string | undefined,
  meta: RequestMeta,
): Promise<Result<{ credentialId: string }>> {
  const expectedChallenge = takeChallenge(ctx, challengeId, 'register', s.userId);
  if (!expectedChallenge) return { ok: false, error: 'The passkey request expired. Please try again.' };
  let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ctx.config.origin,
      expectedRPID: ctx.config.rpId,
      requireUserVerification: false,
    });
  } catch {
    return { ok: false, error: 'The passkey could not be checked. Please try again.' };
  }
  if (!v.verified) return { ok: false, error: 'The passkey could not be checked. Please try again.' };
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
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
      name: name?.trim().slice(0, 40) || 'Passkey',
      createdAt: ctx.now(),
    })
    .run();
  writeAudit(ctx, { actorId: s.userId, action: 'passkey.add', target: `user:${s.userId}`, ip: meta.ip });
  return { ok: true, credentialId: credential.id };
}

export async function signInOptions(ctx: Ctx) {
  const options = await generateAuthenticationOptions({ rpID: ctx.config.rpId, userVerification: 'preferred' });
  return { challengeId: saveChallenge(ctx, 'signin', options.challenge, null), options };
}

async function checkAssertion(ctx: Ctx, p: Passkey, response: AuthenticationResponseJSON, expectedChallenge: string) {
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ctx.config.origin,
      expectedRPID: ctx.config.rpId,
      credential: { id: p.id, publicKey: new Uint8Array(p.publicKey), counter: p.counter, transports: transportsOf(p) },
      requireUserVerification: false,
    });
    if (!v.verified) return false;
    ctx.db
      .update(passkeys)
      .set({ counter: v.authenticationInfo.newCounter, lastUsedAt: ctx.now() })
      .where(eq(passkeys.id, p.id))
      .run();
    return true;
  } catch {
    return false;
  }
}

export async function finishSignIn(
  ctx: Ctx,
  challengeId: string,
  response: AuthenticationResponseJSON,
  meta: RequestMeta,
): Promise<Result<{ userId: number; sessionToken: string }>> {
  const expectedChallenge = takeChallenge(ctx, challengeId, 'signin', null);
  if (!expectedChallenge) return { ok: false, error: 'The passkey request expired. Please try again.' };
  const p = ctx.db.select().from(passkeys).where(eq(passkeys.id, String(response.id))).get();
  if (!p) return { ok: false, error: 'This passkey is not registered here.' };
  if (!(await checkAssertion(ctx, p, response, expectedChallenge))) {
    return { ok: false, error: 'The passkey could not be checked. Please try again.' };
  }
  const { token } = createSession(ctx, p.userId, 'passkey', meta);
  writeAudit(ctx, { actorId: p.userId, action: 'session.passkey', target: `user:${p.userId}`, ip: meta.ip });
  return { ok: true, userId: p.userId, sessionToken: token };
}

/** A fresh assertion for sensitive admin actions, limited to this account's passkeys. */
export async function reauthOptions(ctx: Ctx, s: Session) {
  const options = await generateAuthenticationOptions({
    rpID: ctx.config.rpId,
    userVerification: 'preferred',
    allowCredentials: listPasskeys(ctx, s.userId).map((p) => ({ id: p.id, transports: transportsOf(p) })),
  });
  return { challengeId: saveChallenge(ctx, 'reauth', options.challenge, s.userId), options };
}

export async function finishReauth(
  ctx: Ctx,
  s: Session,
  challengeId: string,
  response: AuthenticationResponseJSON,
  meta: RequestMeta,
): Promise<Result> {
  const expectedChallenge = takeChallenge(ctx, challengeId, 'reauth', s.userId);
  if (!expectedChallenge) return { ok: false, error: 'The passkey request expired. Please try again.' };
  const p = ctx.db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.id, String(response.id)), eq(passkeys.userId, s.userId)))
    .get();
  if (!p) return { ok: false, error: 'Use a passkey of this account.' };
  if (!(await checkAssertion(ctx, p, response, expectedChallenge))) {
    return { ok: false, error: 'The passkey could not be checked. Please try again.' };
  }
  markReauth(ctx, s.id);
  writeAudit(ctx, { actorId: s.userId, action: 'session.reauth', target: `user:${s.userId}`, ip: meta.ip });
  return { ok: true };
}

export function removePasskey(ctx: Ctx, s: Session, passkeyId: string, meta: RequestMeta): Result {
  if (!mayChangePasskeys(ctx, s)) return { ok: false, error: 'Admins confirm with a passkey before changing passkeys.' };
  const r = ctx.db
    .delete(passkeys)
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, s.userId)))
    .run();
  if (r.changes !== 1) return { ok: false, error: 'No such passkey.' };
  writeAudit(ctx, { actorId: s.userId, action: 'passkey.remove', target: `user:${s.userId}`, ip: meta.ip });
  return { ok: true };
}
