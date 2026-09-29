import { createHmac } from 'node:crypto';
import { and, count, eq, gt, lte } from 'drizzle-orm';
import { rateEvents, settings } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';

// Portal spec §3 "Rate limits". Admins can change max and window; the
// messages stay plain.
export const LIMITS = {
  signup_ip: { max: 5, windowS: 3600, message: 'Too many sign-ups from your network. Please try again in about an hour.' },
  signup_email: { max: 3, windowS: 86400, message: 'Too many sign-ups for this email address today. Please try again tomorrow.' },
  magic_email: { max: 5, windowS: 3600, message: 'Too many sign-in links for this email address. Please try again in about an hour.' },
  magic_ip: { max: 20, windowS: 3600, message: 'Too many sign-in link requests from your network. Please try again in about an hour.' },
  email_change_user: {
    max: 5,
    windowS: 86400,
    message: 'Too many email address changes for this account. Please try again tomorrow.',
  },
  number_account: { max: 10, windowS: 86400, message: 'You have asked for numbers too often today. Please try again tomorrow.' },
} as const;

export type LimitName = keyof typeof LIMITS;
export type HitResult = { ok: true } | { ok: false; message: string; retryAfterS: number };

export function isLimitName(s: string): s is LimitName {
  return Object.hasOwn(LIMITS, s);
}

export function limitOf(ctx: Ctx, name: LimitName): { max: number; windowS: number } {
  const row = ctx.db.select().from(settings).where(eq(settings.key, `limit.${name}`)).get();
  if (row) return JSON.parse(row.value) as { max: number; windowS: number };
  return { max: LIMITS[name].max, windowS: LIMITS[name].windowS };
}

export function setLimit(ctx: Ctx, name: LimitName, max: number, windowS?: number): void {
  if (!Number.isInteger(max) || max < 1) throw new Error('max must be a positive integer');
  const w = windowS ?? limitOf(ctx, name).windowS;
  if (!Number.isInteger(w) || w < 1) throw new Error('window must be a positive number of seconds');
  const value = JSON.stringify({ max, windowS: w });
  ctx.db
    .insert(settings)
    .values({ key: `limit.${name}`, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

/** A sub-key derived from the portal secret for one purpose, the same pattern captcha.ts and passkeys.ts use: never the raw secret itself as an HMAC key. */
function sub(ctx: Ctx, label: string): string {
  return createHmac('sha256', ctx.config.secret).update(label).digest('hex');
}

/**
 * The key `hit` stores: an HMAC of the value, never the value itself. Rate
 * limits track emails and IPs, but spec §10 (personal data) says none of it
 * should sit in the database in the clear once its window has nothing left
 * to check it against. Keyed with a label-derived sub-key (not the raw portal
 * secret, and not plain sha256) so a leaked table of hashes can't be
 * brute-forced back to real addresses or IPs.
 */
export function rateKey(ctx: Ctx, name: LimitName, value: string): string {
  return `${name}:${createHmac('sha256', sub(ctx, 'rate-key')).update(value.trim().toLowerCase()).digest('hex')}`;
}

/** The longest configured window, so stale rate-limit rows can be purged (spec §10). */
export function longestWindowMs(ctx: Ctx): number {
  return Math.max(...(Object.keys(LIMITS) as LimitName[]).map((n) => limitOf(ctx, n).windowS)) * 1000;
}

/** Count one attempt against `name` for `key`, unless the limit is already reached. */
export function hit(ctx: Ctx, name: LimitName, key: string): HitResult {
  const { max, windowS } = limitOf(ctx, name);
  const k = rateKey(ctx, name, key);
  const now = ctx.now();
  const since = now - windowS * 1000;
  return ctx.db.transaction((tx) => {
    tx.delete(rateEvents).where(and(eq(rateEvents.key, k), lte(rateEvents.at, since))).run();
    const [{ n }] = tx
      .select({ n: count() })
      .from(rateEvents)
      .where(and(eq(rateEvents.key, k), gt(rateEvents.at, since)))
      .all();
    if (n >= max) return { ok: false as const, message: LIMITS[name].message, retryAfterS: windowS };
    tx.insert(rateEvents).values({ key: k, at: now }).run();
    return { ok: true as const };
  });
}
