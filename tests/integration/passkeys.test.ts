import { beforeEach, describe, expect, it } from 'vitest';
import { users } from '@/db/schema';
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
    expect((await finishSignIn(ctx, late.challengeId, auth.get(late.options), meta)).ok).toBe(false);
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
    expect((await finishSignIn(ctx, b.challengeId, auth.get(c.options), meta)).ok).toBe(false);
  });

  it('refuses a passkey made for another origin', async () => {
    const uid = addUser('ada@example.org');
    await register(uid);
    const phish = new SoftAuthenticator('https://opencell.example.net');
    phish.creds.push(...auth.creds);
    const { challengeId, options } = await signInOptions(ctx);
    expect((await finishSignIn(ctx, challengeId, phish.get(options), meta)).ok).toBe(false);
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
});
