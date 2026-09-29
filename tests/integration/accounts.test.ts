import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { audit, users } from '@/db/schema';
import {
  changeEmail,
  consumeEmailToken,
  deleteAccount,
  peekEmailToken,
  requestMagicLink,
  setDirectoryListed,
  signUp,
} from '@/lib/accounts';
import { sessionFromToken } from '@/lib/sessions';
import { findUserByEmail } from '@/lib/users';
import { solvedCaptcha } from '../helpers/captcha';
import { type TestCtx, testCtx } from '../helpers/ctx';

const MIN = 60_000;
const meta = { ip: '192.0.2.10', userAgent: 'vitest' };
let ctx: TestCtx;

beforeEach(() => {
  ctx = testCtx();
});

function tokenOf(url: string) {
  expect(url.startsWith('https://portal.test/auth/email/')).toBe(true);
  return url.split('/').pop()!;
}

async function signUpAndVerify(name: string, email: string) {
  expect(await signUp(ctx, { name, email, altcha: await solvedCaptcha(ctx) }, meta)).toEqual({ ok: true });
  const r = await consumeEmailToken(ctx, tokenOf(ctx.mailer.lastLink(email)), meta);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('sign-up and email verification (spec §3)', () => {
  it('sends a 30-minute link; the account can do nothing until it is opened', async () => {
    expect(await signUp(ctx, { name: ' Ada ', email: 'Ada@Example.org ', altcha: await solvedCaptcha(ctx) }, meta)).toEqual({ ok: true });
    const u = findUserByEmail(ctx, 'ada@example.org')!;
    expect(u).toMatchObject({ name: 'Ada', email: 'ada@example.org', emailVerifiedAt: null, directoryListed: true });
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0].subject).toBe('Confirm your email for OpenCell');
    const token = tokenOf(ctx.mailer.lastLink('ada@example.org'));
    expect(peekEmailToken(ctx, token)).toEqual({ purpose: 'verify', state: 'ok' });
    const r = await consumeEmailToken(ctx, token, meta);
    expect(r).toMatchObject({ ok: true, purpose: 'verify', userId: u.id });
    if (!r.ok || !r.sessionToken) throw new Error('no session');
    expect(sessionFromToken(ctx, r.sessionToken)?.session.method).toBe('email');
    expect(findUserByEmail(ctx, 'ada@example.org')!.emailVerifiedAt).toBe(ctx.clock.t);
    // single use
    expect(await consumeEmailToken(ctx, token, meta)).toEqual({ ok: false, error: 'This link has already been used.' });
  });

  it('opens one session when the same link is used twice at once (double click, two tabs)', async () => {
    await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    const token = tokenOf(ctx.mailer.lastLink('ada@example.org'));
    const [a, b] = await Promise.all([consumeEmailToken(ctx, token, meta), consumeEmailToken(ctx, token, meta)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(ctx.db.$client.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });

  it('expires the verification link after 30 minutes', async () => {
    await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    const token = tokenOf(ctx.mailer.lastLink('ada@example.org'));
    ctx.clock.t += 30 * MIN;
    expect(peekEmailToken(ctx, token).state).toBe('expired');
    expect(await consumeEmailToken(ctx, token, meta)).toEqual({ ok: false, error: 'This link has expired. Please ask for a new one.' });
  });

  it('needs a solved CAPTCHA', async () => {
    const r = await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: 'bogus' }, meta);
    expect(r).toEqual({ ok: false, error: 'Please complete the “I’m not a robot” check.' });
    expect(ctx.mailer.sent).toHaveLength(0);
    expect(findUserByEmail(ctx, 'ada@example.org')).toBeUndefined();
  });

  it('validates the name and the address', async () => {
    const altcha = await solvedCaptcha(ctx);
    expect(await signUp(ctx, { name: '', email: 'ada@example.org', altcha }, meta)).toMatchObject({ ok: false });
    expect(await signUp(ctx, { name: 'Ada', email: 'not-an-email', altcha }, meta)).toMatchObject({ ok: false });
    expect(await signUp(ctx, { name: 'x'.repeat(81), email: 'ada@example.org', altcha }, meta)).toMatchObject({ ok: false });
  });

  it('answers the same for an existing account, and mails it a sign-in link instead', async () => {
    await signUpAndVerify('Ada', 'ada@example.org');
    const r = await signUp(ctx, { name: 'Mallory', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    expect(r).toEqual({ ok: true });
    expect(ctx.mailer.sent.at(-1)!.subject).toBe('Your OpenCell sign-in link');
    expect(findUserByEmail(ctx, 'ada@example.org')!.name).toBe('Ada');
  });

  it('limits sign-ups to 5 per IP per hour and 3 per address per day', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await signUp(ctx, { name: 'U', email: `u${i}@example.org`, altcha: await solvedCaptcha(ctx) }, meta)).ok).toBe(true);
    }
    const sixth = await signUp(ctx, { name: 'U', email: 'u9@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    expect(sixth).toEqual({ ok: false, error: 'Too many sign-ups from your network. Please try again in about an hour.' });
    for (let i = 0; i < 3; i++) {
      const r = await signUp(ctx, { name: 'V', email: 'v@example.org', altcha: await solvedCaptcha(ctx) }, { ip: `198.51.100.${i}` });
      expect(r.ok).toBe(true);
    }
    const fourth = await signUp(ctx, { name: 'V', email: 'v@example.org', altcha: await solvedCaptcha(ctx) }, { ip: '198.51.100.9' });
    expect(fourth).toEqual({ ok: false, error: 'Too many sign-ups for this email address today. Please try again tomorrow.' });
  });
});

describe('magic links (spec §3)', () => {
  it('signs in a verified account with a 15-minute, single-use link', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    expect(await requestMagicLink(ctx, { email: 'ADA@example.org' })).toEqual({ ok: true });
    const token = tokenOf(ctx.mailer.lastLink('ada@example.org'));
    ctx.clock.t += 15 * MIN - 1;
    const r = await consumeEmailToken(ctx, token, meta);
    expect(r).toMatchObject({ ok: true, purpose: 'magic', userId });
    expect((await consumeEmailToken(ctx, token, meta)).ok).toBe(false);
  });

  it('expires after 15 minutes', async () => {
    await signUpAndVerify('Ada', 'ada@example.org');
    await requestMagicLink(ctx, { email: 'ada@example.org' });
    const token = tokenOf(ctx.mailer.lastLink('ada@example.org'));
    ctx.clock.t += 15 * MIN;
    expect((await consumeEmailToken(ctx, token, meta)).ok).toBe(false);
  });

  it('says the same for an unknown address and sends nothing', async () => {
    expect(await requestMagicLink(ctx, { email: 'nobody@example.org' })).toEqual({ ok: true });
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('re-sends the verification link to an unverified account', async () => {
    await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    await requestMagicLink(ctx, { email: 'ada@example.org' });
    expect(ctx.mailer.sent.map((m) => m.subject)).toEqual(['Confirm your email for OpenCell', 'Confirm your email for OpenCell']);
  });

  it('allows 5 per address per hour', async () => {
    await signUpAndVerify('Ada', 'ada@example.org');
    for (let i = 0; i < 5; i++) expect((await requestMagicLink(ctx, { email: 'ada@example.org' })).ok).toBe(true);
    expect(await requestMagicLink(ctx, { email: 'ada@example.org' })).toEqual({
      ok: false,
      error: 'Too many sign-in links for this email address. Please try again in about an hour.',
    });
  });
});

describe('account page services (spec §3)', () => {
  it('changes the email only after the new address is verified, and tells the old one', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    expect(await changeEmail(ctx, userId, { email: 'ada@new.example' })).toEqual({ ok: true });
    expect(findUserByEmail(ctx, 'ada@example.org')).toBeDefined();
    const r = await consumeEmailToken(ctx, tokenOf(ctx.mailer.lastLink('ada@new.example')), meta);
    expect(r).toMatchObject({ ok: true, purpose: 'email_change', userId });
    expect(findUserByEmail(ctx, 'ada@new.example')?.id).toBe(userId);
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ to: 'ada@example.org', subject: 'Your OpenCell email address was changed' });
  });

  it('does not move an address onto an account that another account holds', async () => {
    const a = await signUpAndVerify('Ada', 'ada@example.org');
    await signUpAndVerify('Bob', 'bob@example.org');
    expect(await changeEmail(ctx, a.userId, { email: 'bob@example.org' })).toEqual({ ok: true });
    expect(ctx.mailer.sent.filter((m) => m.subject.startsWith('Confirm your new email'))).toHaveLength(0);
  });

  it('lists in the directory by default, and can opt out', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    setDirectoryListed(ctx, userId, false, meta);
    expect(findUserByEmail(ctx, 'ada@example.org')!.directoryListed).toBe(false);
  });

  it('deletes an account: releases unactivated numbers, disables or keeps activated ones as chosen', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    const unact = '+883171746412345';
    const keep = '+883171746412346';
    const off = '+883171746412347';
    await ctx.core.subCreate(userId, unact);
    ctx.core.simActivate((await ctx.core.subCreate(userId, keep)).qr, 1);
    ctx.core.simActivate((await ctx.core.subCreate(userId, off)).qr, 2);
    const owned = [
      { number: unact, activated: false },
      { number: keep, activated: true },
      { number: off, activated: true },
    ];
    const r = await deleteAccount(ctx, userId, { confirmEmail: 'ada@example.org', choices: { [keep]: 'keep', [off]: 'disable' } }, meta, owned);
    expect(r).toEqual({ ok: true });
    expect(await ctx.core.numCheck(0, unact)).toBe('free');
    expect((await ctx.core.subStatus(0, keep)).disabled).toBe(false);
    expect((await ctx.core.subStatus(0, off)).disabled).toBe(true);
    expect(ctx.db.select().from(users).where(eq(users.id, userId)).get()).toBeUndefined();
    const rows = ctx.db.select().from(audit).where(eq(audit.action, 'account.delete')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(userId);
    expect(JSON.stringify(rows)).not.toContain('ada@example.org');
  });

  it('refuses to delete without the typed address or with an activated number left undecided', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    expect(await deleteAccount(ctx, userId, { confirmEmail: 'x@example.org', choices: {} }, meta, [])).toMatchObject({ ok: false });
    const owned = [{ number: '+883171746412345', activated: true }];
    expect(await deleteAccount(ctx, userId, { confirmEmail: 'ada@example.org', choices: {} }, meta, owned)).toEqual({
      ok: false,
      error: 'Choose what happens to +883171746412345.',
    });
    expect(findUserByEmail(ctx, 'ada@example.org')).toBeDefined();
  });
});
