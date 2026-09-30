import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, emailTokens, rateEvents, sessions, users } from '@/db/schema';
import {
  changeEmail,
  consumeEmailToken,
  deleteAccount,
  peekEmailToken,
  purgeStale,
  requestMagicLink,
  setDirectoryListed,
  signUp,
} from '@/lib/accounts';
import { HOUSEKEEPING_MS, startHousekeeping } from '@/lib/housekeeping';
import { rateKey, setLimit } from '@/lib/ratelimit';
import { createSession, sessionFromToken } from '@/lib/sessions';
import { hashToken, newToken } from '@/lib/tokens';
import { findUserByEmail, grantRole, revokeRole } from '@/lib/users';
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

describe('the sign-up name in mail (final review I2)', () => {
  it('refuses a name with line breaks or invisible characters, and mails nothing', async () => {
    for (const name of ['Ada\n\nACTION NEEDED: re-verify at https://evil.example/oc now\n', 'Ad\u200Ba', '\u202Eecila Ada']) {
      expect(await signUp(ctx, { name, email: 'victim@example.org', altcha: await solvedCaptcha(ctx) }, meta)).toEqual({
        ok: false,
        error: 'Please use plain text for your name, on one line.',
      });
    }
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent).toHaveLength(0);
    expect(findUserByEmail(ctx, 'victim@example.org')).toBeUndefined();
  });

  it('never puts the name in mail to an address that is not verified yet', async () => {
    await signUp(ctx, { name: 'Mallory Visit-evil.example', email: 'victim@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    await requestMagicLink(ctx, { email: 'victim@example.org' }, meta); // a second verification mail
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent).toHaveLength(2);
    for (const m of ctx.mailer.sent) {
      expect(m.subject).toBe('Confirm your email for OpenCell');
      expect(m.text).not.toContain('Mallory');
      expect(m.text).not.toContain('evil.example');
      expect(m.text.startsWith('Hello,\n')).toBe(true);
    }
  });

  it('never puts the name in the confirmation mailed to a new address, but greets a verified address by name', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    await changeEmail(ctx, userId, { email: 'someone@new.example' });
    await requestMagicLink(ctx, { email: 'ada@example.org' }, meta);
    await ctx.mailQueue.drain();
    const change = ctx.mailer.sent.find((m) => m.to === 'someone@new.example')!;
    expect(change.subject).toBe('Confirm your new email for OpenCell');
    expect(change.text).not.toContain('Ada');
    expect(change.text.startsWith('Hello,\n')).toBe(true);
    expect(ctx.mailer.sent.at(-1)!.text.startsWith('Hello Ada,\n')).toBe(true); // the sign-in link to the verified address
  });
});

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

  it('rejects a verify link for an account that is already verified, like a used one, and opens no session', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    const stray = newToken();
    ctx.db
      .insert(emailTokens)
      .values({ id: hashToken(stray), userId, purpose: 'verify', createdAt: ctx.clock.t, expiresAt: ctx.clock.t + 30 * MIN })
      .run();
    expect(await consumeEmailToken(ctx, stray, meta)).toEqual({ ok: false, error: 'This link has already been used.' });
    expect(ctx.db.$client.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 }); // only the original
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

  it('does not wait on the mail sender, so an existing address answers no slower than a new one', async () => {
    await signUpAndVerify('Ada', 'ada@example.org');
    let release: () => void = () => {};
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.mailer.send = async (m) => {
      await stuck;
      ctx.mailer.sent.push(m);
    };
    const race = await Promise.race([
      signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta).then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);
    expect(race).toBe('done'); // resolved without waiting for the stuck send
    release();
    await ctx.mailQueue.drain();
  });
});

describe('magic links (spec §3)', () => {
  it('signs in a verified account with a 15-minute, single-use link', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    expect(await requestMagicLink(ctx, { email: 'ADA@example.org' }, meta)).toEqual({ ok: true });
    const token = tokenOf(ctx.mailer.lastLink('ada@example.org'));
    ctx.clock.t += 15 * MIN - 1;
    const r = await consumeEmailToken(ctx, token, meta);
    expect(r).toMatchObject({ ok: true, purpose: 'magic', userId });
    expect((await consumeEmailToken(ctx, token, meta)).ok).toBe(false);
  });

  it('expires after 15 minutes', async () => {
    await signUpAndVerify('Ada', 'ada@example.org');
    await requestMagicLink(ctx, { email: 'ada@example.org' }, meta);
    const token = tokenOf(ctx.mailer.lastLink('ada@example.org'));
    ctx.clock.t += 15 * MIN;
    expect((await consumeEmailToken(ctx, token, meta)).ok).toBe(false);
  });

  it('says the same for an unknown address and sends nothing', async () => {
    expect(await requestMagicLink(ctx, { email: 'nobody@example.org' }, meta)).toEqual({ ok: true });
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('re-sends the verification link to an unverified account', async () => {
    await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    await requestMagicLink(ctx, { email: 'ada@example.org' }, meta);
    expect(ctx.mailer.sent.map((m) => m.subject)).toEqual(['Confirm your email for OpenCell', 'Confirm your email for OpenCell']);
  });

  it('allows 5 per address per hour', async () => {
    await signUpAndVerify('Ada', 'ada@example.org');
    for (let i = 0; i < 5; i++) expect((await requestMagicLink(ctx, { email: 'ada@example.org' }, meta)).ok).toBe(true);
    expect(await requestMagicLink(ctx, { email: 'ada@example.org' }, meta)).toEqual({
      ok: false,
      error: 'Too many sign-in links for this email address. Please try again in about an hour.',
    });
  });

  it('limits sign-in link requests to 20 per IP per hour, even across many unknown addresses', async () => {
    for (let i = 0; i < 20; i++) expect((await requestMagicLink(ctx, { email: `nobody${i}@example.org` }, meta)).ok).toBe(true);
    expect(await requestMagicLink(ctx, { email: 'nobody20@example.org' }, meta)).toEqual({
      ok: false,
      error: 'Too many sign-in link requests from your network. Please try again in about an hour.',
    });
  });

  it('does not wait on the mail sender, so a known address answers no slower than an unknown one', async () => {
    await signUpAndVerify('Ada', 'ada@example.org');
    let release: () => void = () => {};
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.mailer.send = async (m) => {
      await stuck;
      ctx.mailer.sent.push(m);
    };
    const race = await Promise.race([
      requestMagicLink(ctx, { email: 'ada@example.org' }, meta).then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);
    expect(race).toBe('done'); // resolved without waiting for the stuck send
    release();
    await ctx.mailQueue.drain();
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

  it('revokes other sessions and unused sign-in links once the email is changed', async () => {
    const first = await signUpAndVerify('Ada', 'ada@example.org');
    const other = createSession(ctx, first.userId, 'email', meta);
    await requestMagicLink(ctx, { email: 'ada@example.org' }, meta); // a stray, still-unused link
    const staleMagic = tokenOf(ctx.mailer.lastLink('ada@example.org'));
    await changeEmail(ctx, first.userId, { email: 'ada@new.example' });
    const r = await consumeEmailToken(ctx, tokenOf(ctx.mailer.lastLink('ada@new.example')), meta);
    expect(r).toMatchObject({ ok: true });
    expect(sessionFromToken(ctx, first.sessionToken!)).toBeNull();
    expect(sessionFromToken(ctx, other.token)).toBeNull();
    expect((await consumeEmailToken(ctx, staleMagic, meta)).ok).toBe(false);
  });

  it('signs the clicking browser in with a fresh session once an email change is confirmed', async () => {
    const first = await signUpAndVerify('Ada', 'ada@example.org');
    const other = createSession(ctx, first.userId, 'email', meta);
    await changeEmail(ctx, first.userId, { email: 'ada@new.example' });
    const r = await consumeEmailToken(ctx, tokenOf(ctx.mailer.lastLink('ada@new.example')), meta);
    expect(r).toMatchObject({ ok: true, purpose: 'email_change', userId: first.userId });
    if (!r.ok) throw new Error('expected ok');
    expect(sessionFromToken(ctx, first.sessionToken!)).toBeNull();
    expect(sessionFromToken(ctx, other.token)).toBeNull();
    expect(r.sessionToken).toBeTruthy();
    const live = ctx.db.select().from(sessions).where(eq(sessions.userId, first.userId)).all();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ method: 'email', uv: false, credentialId: null });
    expect(sessionFromToken(ctx, r.sessionToken!)?.session.id).toBe(live[0].id);
  });

  it('limits email changes to 5 per account per day', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    for (let i = 0; i < 5; i++) {
      expect(await changeEmail(ctx, userId, { email: `new${i}@example.org` })).toEqual({ ok: true });
    }
    expect(await changeEmail(ctx, userId, { email: 'new5@example.org' })).toEqual({
      ok: false,
      error: 'Too many email address changes for this account. Please try again tomorrow.',
    });
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

  it('rejects input that does not match its shape instead of throwing', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    expect(await deleteAccount(ctx, userId, { confirmEmail: 'ada@example.org', choices: { x: 'delete-everything' } }, meta, [])).toMatchObject({
      ok: false,
    });
    expect(await deleteAccount(ctx, userId, 'not an object', meta, [])).toMatchObject({ ok: false });
    expect(findUserByEmail(ctx, 'ada@example.org')).toBeDefined();
  });

  it('stops and reports what changed if the core fails partway through, without throwing', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    const released = '+883171746412345';
    const missing = '+883171746412346'; // never created in the core: subDisable will throw
    await ctx.core.subCreate(userId, released);
    const owned = [
      { number: released, activated: false },
      { number: missing, activated: true },
    ];
    const r = await deleteAccount(ctx, userId, { confirmEmail: 'ada@example.org', choices: { [missing]: 'disable' } }, meta, owned);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.changed).toEqual({ [released]: 'released' });
    expect(r.error).not.toContain('Nothing else was changed');
    expect(r.error).toContain(released);
    expect(r.error).toContain('released');
    expect(findUserByEmail(ctx, 'ada@example.org')).toBeDefined(); // account kept; nothing else was deleted
  });

  it('refuses to let the last admin delete their own account', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    grantRole(ctx, userId, 'admin', null);
    const r = await deleteAccount(ctx, userId, { confirmEmail: 'ada@example.org', choices: {} }, meta, []);
    expect(r).toEqual({ ok: false, error: 'You are the only admin. Promote another admin first, then delete your account.' });
    expect(findUserByEmail(ctx, 'ada@example.org')).toBeDefined();
  });

  it('allows an admin to delete their own account once another admin exists', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    const other = await signUpAndVerify('Bob', 'bob@example.org');
    grantRole(ctx, userId, 'admin', null);
    grantRole(ctx, other.userId, 'admin', null);
    const r = await deleteAccount(ctx, userId, { confirmEmail: 'ada@example.org', choices: {} }, meta, []);
    expect(r).toEqual({ ok: true });
    expect(findUserByEmail(ctx, 'ada@example.org')).toBeUndefined();
  });

  it('does not list a merely-kept number as something that changed, if a later number fails', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    const kept = '+883171746412345';
    const missing = '+883171746412346'; // never created in the core: subDisable will throw
    const owned = [
      { number: kept, activated: true },
      { number: missing, activated: true },
    ];
    const r = await deleteAccount(
      ctx,
      userId,
      { confirmEmail: 'ada@example.org', choices: { [kept]: 'keep', [missing]: 'disable' } },
      meta,
      owned,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.changed).toEqual({});
    expect(r.error).not.toContain(kept);
    expect(r.error).not.toContain('kept');
  });

  it('re-checks the last-admin guard right before the delete, so a role change racing the core calls cannot slip past it', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    const other = await signUpAndVerify('Bob', 'bob@example.org');
    grantRole(ctx, userId, 'admin', null);
    grantRole(ctx, other.userId, 'admin', null); // two admins: the early guard passes
    const unact = '+883171746412345';
    await ctx.core.subCreate(userId, unact);
    const owned = [{ number: unact, activated: false }];
    const originalRelease = ctx.core.subRelease.bind(ctx.core);
    ctx.core.subRelease = async (uid: number, number: string) => {
      // A concurrent request demotes the other admin while this deletion's
      // core call is in flight, making userId the last admin after all.
      revokeRole(ctx, other.userId, 'admin', null);
      return originalRelease(uid, number);
    };
    try {
      const r = await deleteAccount(ctx, userId, { confirmEmail: 'ada@example.org', choices: {} }, meta, owned);
      expect(r).toEqual({ ok: false, error: 'You are the only admin. Promote another admin first, then delete your account.' });
      expect(findUserByEmail(ctx, 'ada@example.org')).toBeDefined();
    } finally {
      ctx.core.subRelease = originalRelease;
    }
  });

  it('leaves no trace of the address anywhere, and clears the IP from the account’s audit rows', async () => {
    const { userId } = await signUpAndVerify('Ada', 'ada@example.org');
    await requestMagicLink(ctx, { email: 'ada@example.org' }, meta); // adds a rate-limit row and a stray token
    const r = await deleteAccount(ctx, userId, { confirmEmail: 'ada@example.org', choices: {} }, meta, []);
    expect(r).toEqual({ ok: true });
    const tables = ctx.db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const dump = tables.flatMap((t) => ctx.db.$client.prepare(`SELECT * FROM ${t.name}`).all());
    expect(JSON.stringify(dump)).not.toContain('ada@example.org');
    const rows = ctx.db.select().from(audit).where(eq(audit.actorId, userId)).all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.ip === null)).toBe(true);
  });
});

describe('housekeeping (spec §10)', () => {
  it('purges an account never verified after 7 days, and with it the sign-up IP and every trace of the address', async () => {
    setLimit(ctx, 'signup_email', 3, 30 * 86400); // a window longer than the 7 days, so its row would outlive the account
    await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    await requestMagicLink(ctx, { email: 'ada@example.org' }, meta);
    const id = findUserByEmail(ctx, 'ada@example.org')!.id;
    expect(ctx.db.select().from(audit).where(eq(audit.actorId, id)).all().map((r) => r.ip)).toEqual([meta.ip]);
    const kept = await signUpAndVerify('Bob', 'bob@example.org'); // verified: stays, with its audit IPs
    ctx.clock.t += 7 * 24 * 3600_000 + MIN;
    purgeStale(ctx);
    expect(findUserByEmail(ctx, 'ada@example.org')).toBeUndefined();
    const rows = ctx.db.select().from(audit).where(eq(audit.actorId, id)).all();
    expect(rows.map((r) => r.action)).toEqual(['account.signup']); // the audit keeps the account id only
    expect(rows.every((r) => r.ip === null && r.detail === null)).toBe(true);
    const tables = ctx.db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const dump = JSON.stringify(tables.flatMap((t) => ctx.db.$client.prepare(`SELECT * FROM ${t.name}`).all()));
    expect(dump).not.toContain('ada@example.org');
    expect(ctx.db.select().from(rateEvents).all().map((r) => r.key)).not.toContain(rateKey(ctx, 'signup_email', 'ada@example.org'));
    expect(findUserByEmail(ctx, 'bob@example.org')?.id).toBe(kept.userId);
    expect(ctx.db.select().from(audit).where(eq(audit.actorId, kept.userId)).all().some((r) => r.ip === meta.ip)).toBe(true);
  });

  it('purges more stale accounts than SQLite can bind in one statement (12,000), in chunks', () => {
    const N = 12_000;
    const old = ctx.clock.t;
    const ins = ctx.db.$client.prepare('INSERT INTO users (name, email, created_at) VALUES (?, ?, ?)');
    const aud = ctx.db.$client.prepare("INSERT INTO audit (at, actor_id, action, target, ip) VALUES (?, ?, 'account.signup', ?, ?)");
    ctx.db.$client.transaction(() => {
      for (let i = 0; i < N; i++) {
        const id = Number(ins.run(`u${i}`, `u${i}@example.org`, old).lastInsertRowid);
        aud.run(old, id, `user:${id}`, meta.ip);
      }
    })();
    ctx.clock.t += 8 * 24 * 3600_000;
    purgeStale(ctx);
    expect(ctx.db.$client.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });
    expect(ctx.db.$client.prepare('SELECT count(*) AS n FROM audit WHERE ip IS NOT NULL').get()).toEqual({ n: 0 });
    expect(ctx.db.$client.prepare('SELECT count(*) AS n FROM audit').get()).toEqual({ n: N });
  });

  it('never fails a sign-up because the purge failed, and logs the failure without details', async () => {
    // A purge that throws: deleting an expired challenge is aborted by a trigger.
    ctx.db.$client.exec("CREATE TRIGGER no_purge BEFORE DELETE ON challenges BEGIN SELECT RAISE(ABORT, 'purge blocked for ada@example.org'); END;");
    ctx.db.$client
      .prepare("INSERT INTO challenges (id, purpose, challenge, expires_at) VALUES ('c1', 'signin', 'x', ?)")
      .run(ctx.clock.t - 1);
    expect(() => purgeStale(ctx)).toThrow();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta)).toEqual({ ok: true });
      await ctx.mailQueue.drain();
      expect(ctx.mailer.sent.map((m) => m.subject)).toEqual(['Confirm your email for OpenCell']);
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0].map(String).join(' ');
      expect(line).toMatch(/purge failed/);
      expect(line).not.toContain('ada@example.org');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps an account still inside its 7 days, and its audit IP', async () => {
    await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    const id = findUserByEmail(ctx, 'ada@example.org')!.id;
    ctx.clock.t += 7 * 24 * 3600_000 - MIN;
    purgeStale(ctx);
    expect(findUserByEmail(ctx, 'ada@example.org')?.id).toBe(id);
    expect(ctx.db.select().from(audit).where(eq(audit.actorId, id)).get()?.ip).toBe(meta.ip);
  });

  it('runs the purge when the server’s context starts, and again every hour', async () => {
    vi.useFakeTimers();
    try {
      await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta);
      ctx.clock.t += 8 * 24 * 3600_000;
      const stop = startHousekeeping(ctx);
      expect(findUserByEmail(ctx, 'ada@example.org')).toBeUndefined(); // at once
      await signUp(ctx, { name: 'Bob', email: 'bob@example.org', altcha: await solvedCaptcha(ctx) }, meta);
      ctx.clock.t += 8 * 24 * 3600_000;
      vi.advanceTimersByTime(HOUSEKEEPING_MS - 1);
      expect(findUserByEmail(ctx, 'bob@example.org')).toBeDefined();
      vi.advanceTimersByTime(1);
      expect(findUserByEmail(ctx, 'bob@example.org')).toBeUndefined(); // on the hour
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the timer going when one purge fails, and logs no details', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = { ...ctx, now: () => { throw new Error('SQLITE_BUSY near ada@example.org'); } };
      const stop = startHousekeeping(failing);
      vi.advanceTimersByTime(HOUSEKEEPING_MS);
      expect(spy).toHaveBeenCalledTimes(2);
      for (const c of spy.mock.calls) expect(c.map(String).join(' ')).not.toContain('ada@example.org');
      stop();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('purges rate-limit rows once no window could still need them', async () => {
    await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    expect(ctx.db.$client.prepare('SELECT count(*) AS n FROM rate_events').get()).not.toEqual({ n: 0 });
    ctx.clock.t += 90 * 24 * 3600_000; // well past every window
    purgeStale(ctx);
    expect(ctx.db.$client.prepare('SELECT count(*) AS n FROM rate_events').get()).toEqual({ n: 0 });
  });

  it('never stores a raw email or IP in the rate-limit table', async () => {
    await signUp(ctx, { name: 'Ada', email: 'ada@example.org', altcha: await solvedCaptcha(ctx) }, meta);
    const rows = ctx.db.select().from(rateEvents).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.key).not.toContain('ada@example.org');
      expect(row.key).not.toContain(meta.ip);
    }
    expect(rows.map((r) => r.key)).toContain(rateKey(ctx, 'signup_email', 'ada@example.org'));
    expect(rows.map((r) => r.key)).toContain(rateKey(ctx, 'signup_ip', meta.ip));
  });
});
