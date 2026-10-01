import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { sessions, users } from '@/db/schema';
import { consumeEmailToken, requestMagicLink, signUp } from '@/lib/accounts';
import { runAdmin } from '@/lib/admin-cli';
import { listAudit } from '@/lib/audit';
import { finishRegistration, finishSignIn, registrationOptions, signInOptions } from '@/lib/passkeys';
import { canUseAdmin, canUseNoc, createSession, sessionFromToken } from '@/lib/sessions';
import { findUserByEmail, rolesOf, STAFF_ONLY, siteAdmits } from '@/lib/users';
import { TEST_ORIGIN, type TestCtx, testCtx } from '../helpers/ctx';
import { SoftAuthenticator } from '../helpers/soft-authenticator';

// NOC design §N1.5: the NOC's own site, with its own accounts. No sign-up:
// the admin CLI adds an account, the person signs in once by email link to
// add a passkey, an admin gives the role, and from then on only staff sign in.

const meta = { ip: '192.0.2.20' };
const NOC = { OC_SITE: 'noc' };
let ctx: TestCtx;
let auth: SoftAuthenticator;

const tokenOf = (link: string) => link.split('/').pop()!;

beforeEach(() => {
  ctx = testCtx(NOC);
  auth = new SoftAuthenticator(TEST_ORIGIN);
});

/** The CLI adds the account; the person opens a mailed link (verifying the address) and is signed in by it. */
async function addAndOpenLink(email: string) {
  expect(runAdmin(ctx, ['add', email, 'Nia', 'Staff']).code).toBe(0);
  expect(await requestMagicLink(ctx, { email }, meta)).toEqual({ ok: true });
  await ctx.mailQueue.drain();
  const r = await consumeEmailToken(ctx, tokenOf(ctx.mailer.lastLink(email)), meta);
  if (!r.ok || !r.sessionToken) throw new Error(r.ok ? 'no session' : r.error);
  return { userId: r.userId, token: r.sessionToken };
}

/** ...and adds a passkey on Account with that session. */
async function bootstrap(email: string) {
  const { userId, token } = await addAndOpenLink(email);
  const s = sessionFromToken(ctx, token)!;
  const { challengeId, options } = await registrationOptions(ctx, s.session);
  const reg = await finishRegistration(ctx, s.session, challengeId, auth.create(options), 'Key', meta);
  if (!reg.ok) throw new Error(reg.error);
  return { userId, token };
}

async function passkeySignIn() {
  const o = await signInOptions(ctx, meta);
  if (!o.ok) throw new Error(o.error);
  return finishSignIn(ctx, o.challengeId, auth.get(o.options), meta);
}

const sessionCount = (userId: number) => ctx.db.select().from(sessions).where(eq(sessions.userId, userId)).all().length;

describe('sign-up on the NOC site', () => {
  it('is closed: no account and no mail', async () => {
    const r = await signUp(ctx, { name: 'Eve', email: 'eve@example.org', altcha: 'x' }, meta);
    expect(r).toEqual({ ok: false, error: 'Sign-up is not open on this site.' });
    await ctx.mailQueue.drain();
    expect(findUserByEmail(ctx, 'eve@example.org')).toBeUndefined();
    expect(ctx.mailer.sent).toEqual([]);
  });
});

describe('oc-portal-admin add', () => {
  it('adds an unverified account, audited, and says what comes next', () => {
    const r = runAdmin(ctx, ['add', 'NIA@example.org', 'Nia', 'Staff']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      'nia@example.org added. Next, within 7 days: they open https://portal.test/sign-in, ask for an email link and add a passkey on Account; then run promote or noc-grant for them.',
    );
    const u = findUserByEmail(ctx, 'nia@example.org')!;
    expect(u).toMatchObject({ name: 'Nia Staff', emailVerifiedAt: null });
    expect(rolesOf(ctx, u.id)).toEqual([]);
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: null, action: 'account.add', target: `user:${u.id}` });
  });

  it('refuses an address that has an account, a bad address, a missing name', () => {
    runAdmin(ctx, ['add', 'nia@example.org', 'Nia']);
    expect(runAdmin(ctx, ['add', 'nia@example.org', 'Other'])).toEqual({ code: 1, out: 'nia@example.org already has an account' });
    expect(runAdmin(ctx, ['add', 'not-an-email', 'X'])).toEqual({ code: 1, out: 'Please enter a valid email address.' });
    expect(runAdmin(ctx, ['add', 'x@example.org']).code).toBe(2);
    expect(runAdmin(ctx, ['add', 'x@example.org', ' ']).code).toBe(1);
  });

  it('is for the NOC site only: on the portal, accounts come from sign-up', () => {
    const portal = testCtx();
    expect(runAdmin(portal, ['add', 'nia@example.org', 'Nia'])).toEqual({
      code: 1,
      out: 'accounts on the subscriber portal come from sign-up; add is for the NOC site (OC_SITE=noc)',
    });
    expect(findUserByEmail(portal, 'nia@example.org')).toBeUndefined();
  });
});

describe('only staff sign in, after the first passkey', () => {
  it('lets an added account in by email link until it has a passkey, then not until it has a role', async () => {
    const { userId, token } = await bootstrap('nia@example.org');
    // The passkey is added: the account is no longer admitted, so its email-link session is gone.
    expect(siteAdmits(ctx, userId)).toBe(false);
    expect(sessionFromToken(ctx, token)).toBeNull();
    expect(sessionCount(userId)).toBe(0);
    // Its passkey does not sign it in either, and opens no session.
    expect(await passkeySignIn()).toEqual({ ok: false, error: STAFF_ONLY });
    expect(sessionCount(userId)).toBe(0);
    // Nor does an email link now.
    await requestMagicLink(ctx, { email: 'nia@example.org' }, meta);
    await ctx.mailQueue.drain();
    expect(await consumeEmailToken(ctx, tokenOf(ctx.mailer.lastLink('nia@example.org')), meta)).toEqual({ ok: false, error: STAFF_ONLY });
    expect(sessionCount(userId)).toBe(0);
  });

  it('refuses to promote an account with no passkey yet (it could never add one as staff)', async () => {
    await addAndOpenLink('ada@example.org');
    expect(runAdmin(ctx, ['promote', 'ada@example.org'])).toEqual({
      code: 1,
      out: 'ada@example.org has no passkey yet: ask them to add one on Account first',
    });
    expect(rolesOf(ctx, findUserByEmail(ctx, 'ada@example.org')!.id)).toEqual(['subscriber']);
  });

  it('once promoted, the passkey signs in to a session that opens the NOC and the admin pages', async () => {
    const { userId } = await bootstrap('ada@example.org');
    expect(runAdmin(ctx, ['promote', 'ada@example.org'])).toEqual({ code: 0, out: 'ada@example.org is now an admin' });
    const r = await passkeySignIn();
    if (!r.ok) throw new Error(r.error);
    expect(r.userId).toBe(userId);
    const s = sessionFromToken(ctx, r.sessionToken)!;
    expect(canUseNoc(ctx, s.session)).toBe(true);
    expect(canUseAdmin(ctx, s.session)).toBe(true);
  });

  it('a NOC operator likewise; taking the role away signs them out', async () => {
    const { token: emailToken } = await bootstrap('nia@example.org');
    expect(runAdmin(ctx, ['noc-grant', 'nia@example.org'])).toEqual({ code: 0, out: 'nia@example.org is now a NOC operator' });
    const r = await passkeySignIn();
    if (!r.ok) throw new Error(r.error);
    expect(canUseNoc(ctx, sessionFromToken(ctx, r.sessionToken)!.session)).toBe(true);
    expect(runAdmin(ctx, ['noc-revoke', 'nia@example.org'])).toEqual({ code: 0, out: 'nia@example.org is no longer a NOC operator' });
    // Every session it still has is refused on its next use.
    expect(sessionFromToken(ctx, r.sessionToken)).toBeNull();
    expect(sessionFromToken(ctx, emailToken)).toBeNull();
    expect(await passkeySignIn()).toEqual({ ok: false, error: STAFF_ONLY });
  });

  it('asks every passkey added here for user verification, before any role', async () => {
    const { token } = await addAndOpenLink('nia@example.org');
    const s = sessionFromToken(ctx, token)!;
    const { challengeId, options } = await registrationOptions(ctx, s.session);
    expect(options.authenticatorSelection?.userVerification).toBe('required');
    const r = await finishRegistration(ctx, s.session, challengeId, auth.create(options, undefined, false), 'No UV', meta);
    expect(r).toEqual({ ok: false, error: 'The passkey could not be checked. Please try again.' });
  });

  it('on the portal, nothing changes: a subscriber with a passkey signs in', async () => {
    ctx = testCtx();
    const id = ctx.db.insert(users).values({ name: 'Sub', email: 'sub@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
    const { token } = createSession(ctx, id, 'email', meta);
    const s = sessionFromToken(ctx, token)!;
    const { challengeId, options } = await registrationOptions(ctx, s.session);
    expect(options.authenticatorSelection?.userVerification).toBe('preferred');
    expect((await finishRegistration(ctx, s.session, challengeId, auth.create(options), 'Key', meta)).ok).toBe(true);
    expect(sessionFromToken(ctx, token)).not.toBeNull();
    expect((await passkeySignIn()).ok).toBe(true);
  });
});

describe('the passkey the NOC site makes', () => {
  // A person may hold a passkey for each site under the one RP ID: the
  // NOC's says so in its name, so the browser's picker tells them apart.
  it('is named for the NOC', async () => {
    const { token } = await addAndOpenLink('nia@example.org');
    const { options } = await registrationOptions(ctx, sessionFromToken(ctx, token)!.session);
    expect(options.user.name).toBe('nia@example.org (OpenCell NOC)');
    expect(options.user.displayName).toBe('Nia Staff (OpenCell NOC)');
  });
});

describe('the passkey user handle', () => {
  // Same RP ID on both sites (opencell.k4ozi.com). An authenticator replaces
  // a passkey whose RP ID and user handle match a new one, so the two sites
  // must never hand out the same handle, even with the same OC_SECRET.
  it('differs between the portal and the NOC site for the same secret and account id', async () => {
    const handles: string[] = [];
    for (const c of [testCtx(), testCtx(NOC)]) {
      const id = c.db.insert(users).values({ name: 'A', email: 'a@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
      expect(id).toBe(1);
      const { token } = createSession(c, id, 'email', meta);
      handles.push((await registrationOptions(c, sessionFromToken(c, token)!.session)).options.user.id);
    }
    expect(handles[0]).not.toBe(handles[1]);
    // The portal's is unchanged, so passkeys already registered there keep working.
    const old = createHmac('sha256', 'test-secret-test-secret-test-secret-0123').update('user-handle:1').digest().subarray(0, 16).toString('base64url');
    expect(handles[0]).toBe(old);
  });
});

describe('what the NOC site tells a core about its accounts', () => {
  // The two sites' account ids overlap (two databases): the cores' audit
  // (a<actor>) tells them apart by an offset on the NOC's.
  it('is its account id plus 1 000 000; the NOC itself (0) stays 0', async () => {
    const { lookupNumber } = await import('@/lib/noc/lookup');
    const N = '+883171746412345';
    ctx.core.simSubscriber(N, 0x76ad0488, null);
    expect((await lookupNumber(ctx, 42, N, meta.ip)).ok).toBe(true);
    expect(ctx.core.audit.slice(-2).map((a) => [a.actor, a.op])).toEqual([
      [1_000_042, 'sub.status'],
      [1_000_042, 'cdr.list'],
    ]);
    // The site's own audit keeps the account's own id.
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: 42, action: 'noc.lookup' });
  });

  it('on the portal, is the account id itself, as before', async () => {
    const { lookupNumber } = await import('@/lib/noc/lookup');
    ctx = testCtx();
    const N = '+883171746412345';
    ctx.core.simSubscriber(N, 0x76ad0488, null);
    await lookupNumber(ctx, 42, N, meta.ip);
    expect(ctx.core.audit.at(-1)?.actor).toBe(42);
  });
});

describe('the NOC role on the subscriber portal', () => {
  it('is not given there: the CLI says where it is', () => {
    const portal = testCtx();
    portal.db.insert(users).values({ name: 'Nia', email: 'nia@example.org', emailVerifiedAt: 1, createdAt: 1 }).run();
    const out = 'the NOC role is given on the NOC site (OC_SITE=noc), with its own accounts';
    expect(runAdmin(portal, ['noc-grant', 'nia@example.org'])).toEqual({ code: 1, out });
    expect(runAdmin(portal, ['noc-revoke', 'nia@example.org'])).toEqual({ code: 1, out });
  });
});
