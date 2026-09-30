import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finishReauth, finishRegistration, finishSignIn, listPasskeys, reauthOptions, registrationOptions, signInOptions } from '@/lib/passkeys';
import { createSession, sessionFromToken } from '@/lib/sessions';
import { grantRole } from '@/lib/users';
import { users } from '@/db/schema';
import { TEST_ORIGIN, type TestCtx, testCtx } from '../helpers/ctx';
import { SoftAuthenticator } from '../helpers/soft-authenticator';

// The account page's passkey actions (final review I1): an admin whose
// passkey session is not fresh gets a typed { reauth: true } answer the page
// can act on (ask for the passkey, then retry), not just an error text.

const meta = { ip: '192.0.2.10' };
const state: { ctx?: TestCtx; token?: string } = {};

vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/server/request', () => ({
  requireUser: async () => {
    const s = sessionFromToken(state.ctx!, state.token);
    if (!s) throw new Error('NEXT_REDIRECT /sign-in');
    return s;
  },
  requestMeta: async () => meta,
  setSessionCookie: async () => {},
  clearSessionCookie: async () => {},
  currentSession: async () => sessionFromToken(state.ctx!, state.token),
}));

const { passkeyRegisterFinish, passkeyRegisterStart } = await import('@/app/actions/auth');
const { removePasskeyAction } = await import('@/app/actions/account');

let ctx: TestCtx;
let auth: SoftAuthenticator;

function addUser(email: string) {
  return ctx.db.insert(users).values({ name: 'Root', email, emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
}

async function registerByEmailSession(uid: number, a: SoftAuthenticator) {
  const { token } = createSession(ctx, uid, 'email', meta);
  const s = sessionFromToken(ctx, token)!.session;
  const { challengeId, options } = await registrationOptions(ctx, s);
  const r = await finishRegistration(ctx, s, challengeId, a.create(options), 'Phone', meta);
  if (!r.ok) throw new Error(r.error);
}

/** Sign in with the passkey, as the browser would: the session this test's actions act for. */
async function passkeySignIn() {
  const o = await signInOptions(ctx, meta);
  if (!o.ok) throw new Error(o.error);
  const r = await finishSignIn(ctx, o.challengeId, auth.get(o.options, 0), meta);
  if (!r.ok) throw new Error(r.error);
  state.token = r.sessionToken;
}

/** What reauthenticate() does in the browser. */
async function confirmWithPasskey() {
  const s = sessionFromToken(ctx, state.token)!.session;
  const { challengeId, options } = await reauthOptions(ctx, s);
  expect((await finishReauth(ctx, s, challengeId, auth.get(options, 0), meta)).ok).toBe(true);
}

beforeEach(() => {
  ctx = testCtx();
  state.ctx = ctx;
  state.token = undefined;
  auth = new SoftAuthenticator(TEST_ORIGIN);
});

describe('account passkey actions for an admin (final review I1)', () => {
  it('answer { reauth: true } to a passkey session that is not fresh, and work once it is confirmed', async () => {
    const uid = addUser('root@example.org');
    await registerByEmailSession(uid, auth);
    grantRole(ctx, uid, 'admin', null);
    await passkeySignIn();

    const first = await passkeyRegisterStart();
    expect(first).toMatchObject({ ok: false, reauth: true });
    await confirmWithPasskey();
    const start = await passkeyRegisterStart();
    if (!start.ok) throw new Error(start.error);
    const key2 = new SoftAuthenticator(TEST_ORIGIN);
    expect(await passkeyRegisterFinish(start.challengeId, key2.create(start.options), 'Backup key')).toEqual({ ok: true });
    expect(listPasskeys(ctx, uid).map((p) => p.name).sort()).toEqual(['Backup key', 'Phone']);

    // Five minutes later the confirmation has lapsed: removing asks again.
    ctx.clock.t += 5 * 60_000;
    const backup = listPasskeys(ctx, uid).find((p) => p.name === 'Backup key')!;
    expect(await removePasskeyAction(backup.id)).toMatchObject({ ok: false, reauth: true });
    expect(listPasskeys(ctx, uid)).toHaveLength(2);
    await confirmWithPasskey();
    expect(await removePasskeyAction(backup.id)).toEqual({ ok: true, message: 'Passkey removed.' });
    expect(listPasskeys(ctx, uid).map((p) => p.name)).toEqual(['Phone']);
  });

  it('answer the registration finish with { reauth: true } when the confirmation lapsed mid-ceremony', async () => {
    const uid = addUser('root@example.org');
    await registerByEmailSession(uid, auth);
    grantRole(ctx, uid, 'admin', null);
    await passkeySignIn();
    await confirmWithPasskey();
    ctx.clock.t += 4 * 60_000;
    const start = await passkeyRegisterStart();
    if (!start.ok) throw new Error(start.error);
    ctx.clock.t += 61_000; // the challenge is still valid; the confirmation has just lapsed
    const r = await passkeyRegisterFinish(start.challengeId, new SoftAuthenticator(TEST_ORIGIN).create(start.options), '');
    expect(r).toMatchObject({ ok: false, reauth: true });
  });

  it('give an admin on an email-link session a plain error, with no re-auth offer (it could not succeed)', async () => {
    const uid = addUser('root@example.org');
    await registerByEmailSession(uid, auth);
    grantRole(ctx, uid, 'admin', null);
    state.token = createSession(ctx, uid, 'email', meta).token;
    const start = await passkeyRegisterStart();
    expect(start).toEqual({ ok: false, error: 'Admins sign in with a passkey, not an email link, before changing passkeys.' });
    expect(await removePasskeyAction(listPasskeys(ctx, uid)[0].id)).toEqual({
      ok: false,
      message: 'Admins sign in with a passkey, not an email link, before changing passkeys.',
    });
  });

  it('let a subscriber add and remove passkeys with no re-auth at all', async () => {
    const uid = ctx.db.insert(users).values({ name: 'Ada', email: 'ada@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
    state.token = createSession(ctx, uid, 'email', meta).token;
    const start = await passkeyRegisterStart();
    if (!start.ok) throw new Error(start.error);
    expect(await passkeyRegisterFinish(start.challengeId, auth.create(start.options), 'Laptop')).toEqual({ ok: true });
    expect(await removePasskeyAction(listPasskeys(ctx, uid)[0].id)).toEqual({ ok: true, message: 'Passkey removed.' });
    expect(await removePasskeyAction('no-such-key')).toEqual({ ok: false, message: 'No such passkey.' });
  });
});
