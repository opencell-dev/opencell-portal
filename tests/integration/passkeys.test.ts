import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { audit, passkeys, sessions, users } from '@/db/schema';
import {
  finishReauth,
  finishRegistration,
  finishSignIn,
  listPasskeys,
  reauthOptions,
  registrationOptions,
  removePasskey,
  signInOptions,
} from '@/lib/passkeys';
import { canUseAdmin, createSession, isFresh, sessionFromToken } from '@/lib/sessions';
import { grantRole } from '@/lib/users';
import { TEST_ORIGIN, type TestCtx, testCtx } from '../helpers/ctx';
import { SoftAuthenticator } from '../helpers/soft-authenticator';

const meta = { ip: '192.0.2.10' };
let ctx: TestCtx;
let auth: SoftAuthenticator;

function addUser(email: string, verified = true) {
  return ctx.db
    .insert(users)
    .values({ name: email.split('@')[0], email, emailVerifiedAt: verified ? 1 : null, createdAt: 1 })
    .returning()
    .get().id;
}

function emailSession(userId: number) {
  const { token } = createSession(ctx, userId, 'email', meta);
  return sessionFromToken(ctx, token)!.session;
}

async function register(userId: number, a = auth, name?: string) {
  const s = emailSession(userId);
  const { challengeId, options } = await registrationOptions(ctx, s);
  const r = await finishRegistration(ctx, s, challengeId, a.create(options), name, meta);
  if (!r.ok) throw new Error(r.error);
  return r;
}

async function signIn(a = auth) {
  const { challengeId, options } = await signInOptions(ctx);
  return finishSignIn(ctx, challengeId, a.get(options), meta);
}

/** An admin session that has just re-authenticated with UV, so passkey changes are allowed. */
async function freshAdminSession(uid: number) {
  const r = await signIn();
  if (!r.ok) throw new Error(r.error);
  const s = sessionFromToken(ctx, r.sessionToken)!.session;
  const { challengeId, options } = await reauthOptions(ctx, s);
  const fr = await finishReauth(ctx, s, challengeId, auth.get(options), meta);
  if (!fr.ok) throw new Error(fr.error);
  return { token: r.sessionToken, session: sessionFromToken(ctx, r.sessionToken)!.session };
}

beforeEach(() => {
  ctx = testCtx();
  auth = new SoftAuthenticator(TEST_ORIGIN);
});

describe('passkeys (spec §3)', () => {
  it('registers a discoverable passkey after verification, then signs in with it', async () => {
    const uid = addUser('ada@example.org');
    const s = emailSession(uid);
    const { options } = await registrationOptions(ctx, s);
    expect(options.rp).toEqual({ name: 'OpenCell', id: 'portal.test' });
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'preferred' });
    await register(uid, auth, 'Phone');
    expect(listPasskeys(ctx, uid).map((p) => p.name)).toEqual(['Phone']);
    const r = await signIn();
    expect(r).toMatchObject({ ok: true, userId: uid });
    if (!r.ok) return;
    expect(sessionFromToken(ctx, r.sessionToken)!.session.method).toBe('passkey');
    expect(listPasskeys(ctx, uid)[0].lastUsedAt).toBe(ctx.clock.t);
    expect(listPasskeys(ctx, uid)[0].deviceType).toBeTruthy();
  });

  it('refuses registration for an unverified account', async () => {
    const uid = addUser('new@example.org', false);
    await expect(registrationOptions(ctx, emailSession(uid))).rejects.toThrow(/verified/);
  });

  it('uses each challenge once, and only within 5 minutes', async () => {
    const uid = addUser('ada@example.org');
    await register(uid);
    const { challengeId, options } = await signInOptions(ctx);
    const answer = auth.get(options);
    expect((await finishSignIn(ctx, challengeId, answer, meta)).ok).toBe(true);
    expect(await finishSignIn(ctx, challengeId, answer, meta)).toEqual({ ok: false, error: 'The passkey request expired. Please try again.' });
    const late = await signInOptions(ctx);
    ctx.clock.t += 5 * 60_000;
    expect(await finishSignIn(ctx, late.challengeId, auth.get(late.options), meta)).toEqual({
      ok: false,
      error: 'The passkey request expired. Please try again.',
    });
  });

  it('refuses an unknown passkey and one answering another challenge', async () => {
    const uid = addUser('ada@example.org');
    await register(uid);
    const stranger = new SoftAuthenticator(TEST_ORIGIN);
    const s = emailSession(uid);
    const reg = await registrationOptions(ctx, s);
    stranger.create(reg.options); // never finished: the portal doesn't know it
    const a = await signInOptions(ctx);
    expect(await finishSignIn(ctx, a.challengeId, stranger.get(a.options), meta)).toEqual({ ok: false, error: 'This passkey is not registered here.' });
    const b = await signInOptions(ctx);
    const c = await signInOptions(ctx);
    expect(await finishSignIn(ctx, b.challengeId, auth.get(c.options), meta)).toEqual({
      ok: false,
      error: 'The passkey could not be checked. Please try again.',
    });
  });

  it('refuses a passkey made for another origin', async () => {
    const uid = addUser('ada@example.org');
    await register(uid);
    const phish = new SoftAuthenticator('https://opencell.example.net');
    phish.creds.push(...auth.creds);
    const { challengeId, options } = await signInOptions(ctx);
    expect(await finishSignIn(ctx, challengeId, phish.get(options), meta)).toEqual({
      ok: false,
      error: 'The passkey could not be checked. Please try again.',
    });
  });

  it('lets a subscriber who lost their passkey sign in by email and add a new one', async () => {
    const uid = addUser('ada@example.org');
    await register(uid);
    const newPhone = new SoftAuthenticator(TEST_ORIGIN);
    await register(uid, newPhone, 'New phone');
    const r = await signIn(newPhone);
    expect(r).toMatchObject({ ok: true, userId: uid });
    expect(listPasskeys(ctx, uid)).toHaveLength(2);
  });

  it('lets a user remove only their own passkeys (A cannot touch B’s)', async () => {
    const a = addUser('ada@example.org');
    const b = addUser('bob@example.org');
    const authB = new SoftAuthenticator(TEST_ORIGIN);
    await register(a);
    const { credentialId: bCred } = await register(b, authB);
    const sa = emailSession(a);
    expect(listPasskeys(ctx, a).map((p) => p.id)).not.toContain(bCred);
    expect(removePasskey(ctx, sa, bCred, meta)).toEqual({ ok: false, error: 'No such passkey.' });
    expect(listPasskeys(ctx, b)).toHaveLength(1);
    const own = listPasskeys(ctx, a)[0].id;
    expect(removePasskey(ctx, sa, own, meta)).toEqual({ ok: true });
    expect(listPasskeys(ctx, a)).toEqual([]);
  });

  it('revokes the sessions a passkey opened, when that passkey is removed', async () => {
    const uid = addUser('ada@example.org');
    await register(uid);
    const r = await signIn();
    if (!r.ok) throw new Error(r.error);
    expect(sessionFromToken(ctx, r.sessionToken)).not.toBeNull();
    const s = emailSession(uid);
    const pkId = listPasskeys(ctx, uid)[0].id;
    expect(removePasskey(ctx, s, pkId, meta)).toEqual({ ok: true });
    expect(sessionFromToken(ctx, r.sessionToken)).toBeNull();
  });

  it('returns a Result error for a duplicate credential id instead of throwing', async () => {
    const forcedId = Buffer.from('AAAAAAAAAAAAAAAA'); // 16 bytes
    const a = addUser('ada@example.org');
    const b = addUser('bob@example.org');
    const sa = emailSession(a);
    const ra = await registrationOptions(ctx, sa);
    expect((await finishRegistration(ctx, sa, ra.challengeId, auth.create(ra.options, forcedId), undefined, meta)).ok).toBe(true);

    const authB = new SoftAuthenticator(TEST_ORIGIN);
    const sb = emailSession(b);
    const rb = await registrationOptions(ctx, sb);
    expect(await finishRegistration(ctx, sb, rb.challengeId, authB.create(rb.options, forcedId), undefined, meta)).toEqual({
      ok: false,
      error: 'This passkey is already registered.',
    });
  });

  it('audits a counter regression as a distinct event', async () => {
    const uid = addUser('ada@example.org');
    await register(uid);
    expect((await signIn()).ok).toBe(true); // counter becomes 1
    ctx.db.update(passkeys).set({ counter: 100 }).where(eq(passkeys.userId, uid)).run();
    const r = await signIn(); // the authenticator's own counter naturally becomes 2, which is <= 100
    expect(r.ok).toBe(false);
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'passkey.counter_regression')).all()).toHaveLength(1);
  });

  it('binds a challenge to the session that requested it, not just the user', async () => {
    const a = addUser('ada@example.org');
    const b = addUser('bob@example.org');
    const sa = emailSession(a);
    const { challengeId, options } = await registrationOptions(ctx, sa);
    const response = auth.create(options);
    const sb = emailSession(b);
    expect(await finishRegistration(ctx, sb, challengeId, response, undefined, meta)).toEqual({
      ok: false,
      error: 'The passkey request expired. Please try again.',
    });
    const s2 = emailSession(a);
    expect(await finishRegistration(ctx, s2, challengeId, response, undefined, meta)).toEqual({
      ok: false,
      error: 'The passkey request expired. Please try again.',
    });
  });

  it('re-checks verification and freshness at finish time', async () => {
    const uid = addUser('ada@example.org');
    const s = emailSession(uid);
    const { challengeId, options } = await registrationOptions(ctx, s);
    const response = auth.create(options);
    ctx.db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, uid)).run();
    expect(await finishRegistration(ctx, s, challengeId, response, undefined, meta)).toEqual({
      ok: false,
      error: 'Only a verified account can add a passkey.',
    });
  });
});

describe('admins (spec §3)', () => {
  it('opens admin pages only for a passkey session', async () => {
    const uid = addUser('root@example.org');
    await register(uid);
    grantRole(ctx, uid, 'admin', null);
    expect(canUseAdmin(ctx, emailSession(uid))).toBe(false);
    const r = await signIn();
    if (!r.ok) throw new Error(r.error);
    expect(canUseAdmin(ctx, sessionFromToken(ctx, r.sessionToken)!.session)).toBe(true);
  });

  it('never treats an unverified passkey sign-in as admin-capable', async () => {
    const uid = addUser('root@example.org');
    await register(uid);
    grantRole(ctx, uid, 'admin', null);
    const { challengeId, options } = await signInOptions(ctx);
    const r = await finishSignIn(ctx, challengeId, auth.get(options, undefined, false), meta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(canUseAdmin(ctx, sessionFromToken(ctx, r.sessionToken)!.session)).toBe(false);
    const withUV = await signIn();
    if (!withUV.ok) throw new Error(withUV.error);
    expect(canUseAdmin(ctx, sessionFromToken(ctx, withUV.sessionToken)!.session)).toBe(true);
  });

  it('re-authenticates with a fresh assertion from the session’s own user', async () => {
    const uid = addUser('root@example.org');
    const other = addUser('eve@example.org');
    const authEve = new SoftAuthenticator(TEST_ORIGIN);
    await register(uid);
    await register(other, authEve);
    grantRole(ctx, uid, 'admin', null);
    const r = await signIn();
    if (!r.ok) throw new Error(r.error);
    const s = sessionFromToken(ctx, r.sessionToken)!.session;
    const eve = await reauthOptions(ctx, s);
    expect(await finishReauth(ctx, s, eve.challengeId, authEve.get(eve.options), meta)).toEqual({
      ok: false,
      error: 'Use a passkey of this account.',
    });
    const mine = await reauthOptions(ctx, s);
    expect(mine.options.allowCredentials?.map((c) => c.id)).toEqual(listPasskeys(ctx, uid).map((p) => p.id));
    expect(await finishReauth(ctx, s, mine.challengeId, auth.get(mine.options), meta)).toEqual({ ok: true });
    expect(isFresh(ctx, sessionFromToken(ctx, r.sessionToken)!.session)).toBe(true);
  });

  it('requires user verification to re-authenticate, but not to sign in', async () => {
    const uid = addUser('root@example.org');
    await register(uid);
    grantRole(ctx, uid, 'admin', null);
    const r = await signIn();
    if (!r.ok) throw new Error(r.error);
    const s = sessionFromToken(ctx, r.sessionToken)!.session;
    const eo = await reauthOptions(ctx, s);
    expect(eo.options.userVerification).toBe('required');
    expect(await finishReauth(ctx, s, eo.challengeId, auth.get(eo.options, undefined, false), meta)).toEqual({
      ok: false,
      error: 'The passkey could not be checked. Please try again.',
    });
    const eo2 = await reauthOptions(ctx, s);
    expect(await finishReauth(ctx, s, eo2.challengeId, auth.get(eo2.options), meta)).toEqual({ ok: true });
  });

  it('refuses re-auth from a non-passkey session', async () => {
    const uid = addUser('ada@example.org');
    await register(uid);
    const s = emailSession(uid);
    const { challengeId, options } = await reauthOptions(ctx, s);
    expect(await finishReauth(ctx, s, challengeId, auth.get(options), meta)).toEqual({
      ok: false,
      error: 'Re-authentication needs a passkey session.',
    });
  });

  it('refuses a sign-in challenge finished as a re-auth (purpose confusion)', async () => {
    const uid = addUser('root@example.org');
    await register(uid);
    grantRole(ctx, uid, 'admin', null);
    const r = await signIn();
    if (!r.ok) throw new Error(r.error);
    const s = sessionFromToken(ctx, r.sessionToken)!.session;
    const signin = await signInOptions(ctx);
    expect(await finishReauth(ctx, s, signin.challengeId, auth.get(signin.options), meta)).toEqual({
      ok: false,
      error: 'The passkey request expired. Please try again.',
    });
  });

  it('refuses admin passkey changes once the fresh re-auth has gone stale', async () => {
    const uid = addUser('root@example.org');
    await register(uid);
    grantRole(ctx, uid, 'admin', null);
    const { token } = await freshAdminSession(uid);
    ctx.clock.t += 5 * 60_000;
    const stale = sessionFromToken(ctx, token)!.session;
    expect(removePasskey(ctx, stale, listPasskeys(ctx, uid)[0].id, meta)).toEqual({
      ok: false,
      error: 'Admins confirm with a passkey before changing passkeys.',
    });
  });

  it('requires user verification to register a second passkey for an admin', async () => {
    const uid = addUser('root@example.org');
    await register(uid);
    grantRole(ctx, uid, 'admin', null);
    const { session: fresh } = await freshAdminSession(uid);
    const { challengeId, options } = await registrationOptions(ctx, fresh);
    expect(options.authenticatorSelection).toMatchObject({ userVerification: 'required' });
    const noUV = new SoftAuthenticator(TEST_ORIGIN); // a throwaway: this attempt is rejected server-side
    expect(await finishRegistration(ctx, fresh, challengeId, noUV.create(options, undefined, false), undefined, meta)).toEqual({
      ok: false,
      error: 'The passkey could not be checked. Please try again.',
    });
    const { session: fresh2 } = await freshAdminSession(uid);
    const good = await registrationOptions(ctx, fresh2);
    expect((await finishRegistration(ctx, fresh2, good.challengeId, auth.create(good.options), undefined, meta)).ok).toBe(true);
  });

  it('re-checks freshness for an admin at registration finish time', async () => {
    const uid = addUser('root@example.org');
    await register(uid);
    grantRole(ctx, uid, 'admin', null);
    const { session: fresh } = await freshAdminSession(uid);
    const { challengeId, options } = await registrationOptions(ctx, fresh);
    const response = auth.create(options);
    ctx.db.update(sessions).set({ reauthAt: null }).where(eq(sessions.id, fresh.id)).run();
    expect(await finishRegistration(ctx, fresh, challengeId, response, undefined, meta)).toEqual({
      ok: false,
      error: 'Admins confirm with a passkey before changing passkeys.',
    });
  });

  it('lets an admin add or remove passkeys only from a fresh passkey session', async () => {
    const uid = addUser('root@example.org');
    await register(uid);
    grantRole(ctx, uid, 'admin', null);
    const s = emailSession(uid);
    await expect(registrationOptions(ctx, s)).rejects.toThrow(/fresh passkey/);
    expect(removePasskey(ctx, s, listPasskeys(ctx, uid)[0].id, meta)).toEqual({
      ok: false,
      error: 'Admins confirm with a passkey before changing passkeys.',
    });
  });

  it('cannot remove an admin’s last passkey, but a subscriber can', async () => {
    const uid = addUser('root@example.org');
    await register(uid);
    grantRole(ctx, uid, 'admin', null);
    const { session: fresh } = await freshAdminSession(uid);
    expect(removePasskey(ctx, fresh, listPasskeys(ctx, uid)[0].id, meta)).toEqual({
      ok: false,
      error: 'Admins need at least one passkey.',
    });

    const sub = addUser('ada@example.org');
    await register(sub);
    const ss = emailSession(sub);
    expect(removePasskey(ctx, ss, listPasskeys(ctx, sub)[0].id, meta)).toEqual({ ok: true });
  });
});
