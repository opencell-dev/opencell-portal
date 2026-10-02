import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { and, count, eq, gt, lte } from 'drizzle-orm';
import { rateEvents, settings } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';

// Portal spec §3 "Rate limits". Admins can change max and window; the
// messages stay plain. `perIp` marks a limit counted per client address:
// those take the address through hitIp, which buckets IPv6 by /64.
export const LIMITS = {
  signup_ip: {
    perIp: true,
    max: 5,
    windowS: 3600,
    message: 'Too many sign-ups from your network. Please try again in about an hour.',
  },
  signup_email: {
    perIp: false,
    max: 3,
    windowS: 86400,
    message: 'Too many sign-ups for this email address today. Please try again tomorrow.',
  },
  magic_email: {
    perIp: false,
    max: 5,
    windowS: 3600,
    message: 'Too many sign-in links for this email address. Please try again in about an hour.',
  },
  magic_ip: {
    perIp: true,
    max: 20,
    windowS: 3600,
    message: 'Too many sign-in link requests from your network. Please try again in about an hour.',
  },
  signin_ip: {
    perIp: true,
    max: 30,
    windowS: 600,
    message: 'Too many passkey sign-in attempts from your network. Please try again in a few minutes.',
  },
  email_change_user: {
    perIp: false,
    max: 5,
    windowS: 86400,
    message: 'Too many email address changes for this account. Please try again tomorrow.',
  },
  number_account: {
    perIp: false,
    max: 10,
    windowS: 86400,
    message: 'You have asked for numbers too often today. Please try again tomorrow.',
  },
  // NOC design §11: a staff number lookup (a number's status and calls).
  noc_lookup: {
    perIp: false,
    max: 120,
    windowS: 3600,
    message: 'Too many number lookups this hour. Please try again later.',
  },
} as const;

export type LimitName = keyof typeof LIMITS;
/** Limits counted per client address (declared with `perIp: true`). */
export type IpLimitName = { [K in LimitName]: (typeof LIMITS)[K]['perIp'] extends true ? K : never }[LimitName];
/** Limits counted per some other key: an email address, an account id. */
export type KeyLimitName = Exclude<LimitName, IpLimitName>;
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
  const v = LIMITS[name].perIp ? ipBucket(value) : value;
  return `${name}:${createHmac('sha256', sub(ctx, 'rate-key')).update(v.trim().toLowerCase()).digest('hex')}`;
}

/** An IPv6 address as its 8 hextets (it must already pass isIPv6, zone id removed). */
function hextets(a: string): number[] {
  let s = a.toLowerCase();
  const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [b0, b1, b2, b3] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...zeros, ...t].map((x) => Number.parseInt(x, 16));
}

/**
 * The bucket a per-IP limit counts a client in. An IPv4 address counts on
 * its own; an IPv6 client counts by its /64, since one line or host usually
 * holds a whole /64 and could otherwise rotate through it; an IPv4-mapped
 * IPv6 address (::ffff:a.b.c.d) is its IPv4 address. Anything else (such as
 * "unknown") is left as it is. The audit and logs keep the full address.
 */
export function ipBucket(ip: string): string {
  const a = ip.trim().replace(/%.*$/, '');
  if (isIPv4(a)) return a;
  if (!isIPv6(a)) return ip;
  const h = hextets(a);
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join('.');
  }
  return `${h.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/** The longest configured window, so stale rate-limit rows can be purged (spec §10). */
export function longestWindowMs(ctx: Ctx): number {
  return Math.max(...(Object.keys(LIMITS) as LimitName[]).map((n) => limitOf(ctx, n).windowS)) * 1000;
}

/** Count one attempt against a keyed limit (email, account id), unless it is already reached. */
export function hit(ctx: Ctx, name: KeyLimitName, key: string): HitResult {
  if (LIMITS[name].perIp) throw new Error(`${name} is a per-IP limit: count it with hitIp`);
  return count1(ctx, name, key);
}

/** Count one attempt from client address `ip` against a per-IP limit (IPv6 bucketed by /64). */
export function hitIp(ctx: Ctx, name: IpLimitName, ip: string): HitResult {
  if (!LIMITS[name].perIp) throw new Error(`${name} is not a per-IP limit: count it with hit`);
  return count1(ctx, name, ip);
}

function count1(ctx: Ctx, name: LimitName, key: string): HitResult {
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
