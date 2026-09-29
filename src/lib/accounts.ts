import { and, eq, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { challenges, emailTokens, sessions, users } from '@/db/schema';
import { writeAudit } from '@/lib/audit';
import { checkCaptcha } from '@/lib/captcha';
import type { Ctx } from '@/lib/ctx';
import { emailChangedNotice, emailChangeMail, magicLinkMail, type Template, verifyMail } from '@/lib/mail-templates';
import { type OwnedNumber, ownedNumbers } from '@/lib/owned-numbers';
import { hit } from '@/lib/ratelimit';
import { createSession, type RequestMeta } from '@/lib/sessions';
import { hashToken, newToken } from '@/lib/tokens';
import { findUserByEmail, getUser } from '@/lib/users';
import { emailSchema, firstError, nameSchema } from '@/lib/validation';

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

type Purpose = 'verify' | 'magic' | 'email_change';

const LIFETIME_MS: Record<Purpose, number> = {
  verify: 30 * 60_000,
  magic: 15 * 60_000,
  email_change: 30 * 60_000,
};

const UNVERIFIED_KEEP_MS = 7 * 24 * 3600_000;

const signUpSchema = z.object({ name: nameSchema, email: emailSchema, altcha: z.string().max(4096) });
const emailOnlySchema = z.object({ email: emailSchema });

/** The link a message carries: a page that asks for one click before the token is used. */
export function linkFor(ctx: Ctx, token: string): string {
  return `${ctx.config.origin}/auth/email/${token}`;
}

function issueEmailToken(ctx: Ctx, userId: number, purpose: Purpose, newEmail?: string): string {
  const token = newToken();
  const now = ctx.now();
  ctx.db.transaction((tx) => {
    // A new link voids the older unused ones of the same kind.
    tx.delete(emailTokens)
      .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose), isNull(emailTokens.usedAt)))
      .run();
    tx.insert(emailTokens)
      .values({ id: hashToken(token), userId, purpose, newEmail: newEmail ?? null, createdAt: now, expiresAt: now + LIFETIME_MS[purpose] })
      .run();
  });
  return token;
}

async function mail(ctx: Ctx, to: string, t: Template) {
  await ctx.mailer.send({ to, subject: t.subject, text: t.text });
}

/** Remove what has run out: expired sessions, links and challenges, and unverified accounts after 7 days. */
export function purgeStale(ctx: Ctx): void {
  const now = ctx.now();
  ctx.db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  ctx.db.delete(emailTokens).where(lt(emailTokens.expiresAt, now - 24 * 3600_000)).run();
  ctx.db.delete(challenges).where(lt(challenges.expiresAt, now)).run();
  ctx.db.delete(users).where(and(isNull(users.emailVerifiedAt), lt(users.createdAt, now - UNVERIFIED_KEEP_MS))).run();
}

/**
 * Sign-up (spec §3): name, email and a solved CAPTCHA. The answer is the same
 * whether or not the address already has an account; an existing verified
 * account is mailed a sign-in link instead of a verification link.
 */
export async function signUp(
  ctx: Ctx,
  input: { name: unknown; email: unknown; altcha: unknown },
  meta: RequestMeta,
): Promise<Result> {
  const p = signUpSchema.safeParse(input);
  if (!p.success) return { ok: false, error: firstError(p.error) };
  const { name, email, altcha } = p.data;
  const byIp = hit(ctx, 'signup_ip', meta.ip);
  if (!byIp.ok) return { ok: false, error: byIp.message };
  if (!(await checkCaptcha(ctx, altcha))) return { ok: false, error: 'Please complete the “I’m not a robot” check.' };
  const byEmail = hit(ctx, 'signup_email', email);
  if (!byEmail.ok) return { ok: false, error: byEmail.message };
  purgeStale(ctx);

  const existing = findUserByEmail(ctx, email);
  if (existing?.emailVerifiedAt) {
    await mail(ctx, email, magicLinkMail(existing.name, linkFor(ctx, issueEmailToken(ctx, existing.id, 'magic'))));
    return { ok: true };
  }
  let userId: number;
  if (existing) {
    ctx.db.update(users).set({ name }).where(eq(users.id, existing.id)).run();
    userId = existing.id;
  } else {
    userId = ctx.db.insert(users).values({ name, email, createdAt: ctx.now() }).returning({ id: users.id }).get().id;
    writeAudit(ctx, { actorId: userId, action: 'account.signup', target: `user:${userId}`, ip: meta.ip });
  }
  await mail(ctx, email, verifyMail(name, linkFor(ctx, issueEmailToken(ctx, userId, 'verify'))));
  return { ok: true };
}

/** Sign-in fallback (spec §3): a 15-minute single-use link, same answer for unknown addresses. */
export async function requestMagicLink(ctx: Ctx, input: { email: unknown }): Promise<Result> {
  const p = emailOnlySchema.safeParse(input);
  if (!p.success) return { ok: false, error: firstError(p.error) };
  const { email } = p.data;
  const lim = hit(ctx, 'magic_email', email);
  if (!lim.ok) return { ok: false, error: lim.message };
  const u = findUserByEmail(ctx, email);
  if (!u) return { ok: true };
  if (!u.emailVerifiedAt) {
    await mail(ctx, email, verifyMail(u.name, linkFor(ctx, issueEmailToken(ctx, u.id, 'verify'))));
  } else {
    await mail(ctx, email, magicLinkMail(u.name, linkFor(ctx, issueEmailToken(ctx, u.id, 'magic'))));
  }
  return { ok: true };
}

type TokenState = 'ok' | 'expired' | 'used' | 'unknown';

/** What a link is for and whether it still works, without using it (the confirm page). */
export function peekEmailToken(ctx: Ctx, token: string): { purpose: Purpose | null; state: TokenState } {
  const row = token.length <= 64 ? ctx.db.select().from(emailTokens).where(eq(emailTokens.id, hashToken(token))).get() : undefined;
  if (!row) return { purpose: null, state: 'unknown' };
  if (row.usedAt !== null) return { purpose: row.purpose, state: 'used' };
  if (row.expiresAt <= ctx.now()) return { purpose: row.purpose, state: 'expired' };
  return { purpose: row.purpose, state: 'ok' };
}

const TOKEN_ERRORS: Record<Exclude<TokenState, 'ok'>, string> = {
  unknown: 'This link is not valid. Please ask for a new one.',
  expired: 'This link has expired. Please ask for a new one.',
  used: 'This link has already been used.',
};

/**
 * Use an emailed link once. Verification and magic links open a session
 * (`sessionToken`); an email-change link moves the account to the new address.
 */
export async function consumeEmailToken(
  ctx: Ctx,
  token: string,
  meta: RequestMeta,
): Promise<Result<{ purpose: Purpose; userId: number; sessionToken?: string }>> {
  const peek = peekEmailToken(ctx, token);
  if (peek.state !== 'ok') return { ok: false, error: TOKEN_ERRORS[peek.state] };
  const now = ctx.now();
  const id = hashToken(token);
  const row = ctx.db.select().from(emailTokens).where(eq(emailTokens.id, id)).get()!;
  const claimed = ctx.db
    .update(emailTokens)
    .set({ usedAt: now })
    .where(and(eq(emailTokens.id, id), isNull(emailTokens.usedAt)))
    .run();
  if (claimed.changes !== 1) return { ok: false, error: TOKEN_ERRORS.used };
  const u = getUser(ctx, row.userId);
  if (!u) return { ok: false, error: TOKEN_ERRORS.unknown };

  if (row.purpose === 'email_change') {
    const newEmail = row.newEmail!;
    const holder = findUserByEmail(ctx, newEmail);
    if (holder && holder.id !== u.id) return { ok: false, error: 'That address now belongs to another account.' };
    ctx.db.update(users).set({ email: newEmail }).where(eq(users.id, u.id)).run();
    writeAudit(ctx, { actorId: u.id, action: 'account.email_change', target: `user:${u.id}`, ip: meta.ip });
    try {
      await mail(ctx, u.email, emailChangedNotice(u.name, newEmail));
    } catch (e) {
      console.error('email change notice to the old address failed:', e);
    }
    return { ok: true, purpose: row.purpose, userId: u.id };
  }
  if (row.purpose === 'verify' && !u.emailVerifiedAt) {
    ctx.db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, u.id)).run();
    writeAudit(ctx, { actorId: u.id, action: 'account.verify', target: `user:${u.id}`, ip: meta.ip });
  }
  const { token: sessionToken } = createSession(ctx, u.id, 'email', meta);
  writeAudit(ctx, { actorId: u.id, action: 'session.email', target: `user:${u.id}`, ip: meta.ip });
  return { ok: true, purpose: row.purpose, userId: u.id, sessionToken };
}

/** Account page: a new address takes effect once its own link is opened (spec §3). */
export async function changeEmail(ctx: Ctx, userId: number, input: { email: unknown }): Promise<Result> {
  const p = emailOnlySchema.safeParse(input);
  if (!p.success) return { ok: false, error: firstError(p.error) };
  const { email } = p.data;
  const u = getUser(ctx, userId);
  if (!u) return { ok: false, error: 'No such account.' };
  if (email === u.email) return { ok: false, error: 'That is already your address.' };
  const lim = hit(ctx, 'magic_email', email);
  if (!lim.ok) return { ok: false, error: lim.message };
  if (findUserByEmail(ctx, email)) return { ok: true }; // say nothing about other accounts
  await mail(ctx, email, emailChangeMail(u.name, linkFor(ctx, issueEmailToken(ctx, userId, 'email_change', email))));
  return { ok: true };
}

export function setDirectoryListed(ctx: Ctx, userId: number, listed: boolean, meta: RequestMeta): void {
  ctx.db.update(users).set({ directoryListed: listed }).where(eq(users.id, userId)).run();
  writeAudit(ctx, { actorId: userId, action: 'account.directory', target: `user:${userId}`, detail: { listed }, ip: meta.ip });
}

export type NumberChoice = 'keep' | 'disable';

/**
 * Delete an account (spec §3, §10): numbers never activated are released;
 * each activated number is kept working unmanaged or disabled, as the user
 * chose. The personal data goes; the audit keeps the account id only.
 */
export async function deleteAccount(
  ctx: Ctx,
  userId: number,
  input: { confirmEmail: string; choices: Record<string, NumberChoice> },
  meta: RequestMeta,
  owned: OwnedNumber[] = ownedNumbers(ctx, userId),
): Promise<Result> {
  const u = getUser(ctx, userId);
  if (!u) return { ok: false, error: 'No such account.' };
  if (input.confirmEmail.trim().toLowerCase() !== u.email) {
    return { ok: false, error: 'Type your email address exactly to confirm.' };
  }
  for (const n of owned) {
    if (n.activated && input.choices[n.number] !== 'keep' && input.choices[n.number] !== 'disable') {
      return { ok: false, error: `Choose what happens to ${n.number}.` };
    }
  }
  const outcome: Record<string, string> = {};
  for (const n of owned) {
    if (!n.activated) {
      await ctx.core.subRelease(userId, n.number);
      outcome[n.number] = 'released';
    } else if (input.choices[n.number] === 'disable') {
      await ctx.core.subDisable(userId, n.number);
      outcome[n.number] = 'disabled';
    } else {
      outcome[n.number] = 'kept';
    }
  }
  ctx.db.delete(users).where(eq(users.id, userId)).run();
  writeAudit(ctx, { actorId: userId, action: 'account.delete', target: `user:${userId}`, detail: { numbers: outcome }, ip: meta.ip });
  return { ok: true };
}
