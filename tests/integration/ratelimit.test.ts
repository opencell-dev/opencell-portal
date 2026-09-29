import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { rateEvents } from '@/db/schema';
import { writeAudit, listAudit } from '@/lib/audit';
import { hit, limitOf, rateKey, setLimit } from '@/lib/ratelimit';
import { type TestCtx, testCtx } from '../helpers/ctx';

let ctx: TestCtx;
beforeEach(() => {
  ctx = testCtx();
});

describe('rate limits (portal spec §3)', () => {
  it('has the spec’s numbers', () => {
    expect(limitOf(ctx, 'signup_ip')).toEqual({ max: 5, windowS: 3600 });
    expect(limitOf(ctx, 'signup_email')).toEqual({ max: 3, windowS: 86400 });
    expect(limitOf(ctx, 'magic_email')).toEqual({ max: 5, windowS: 3600 });
    expect(limitOf(ctx, 'magic_ip')).toEqual({ max: 20, windowS: 3600 });
    expect(limitOf(ctx, 'signin_ip')).toEqual({ max: 30, windowS: 600 });
    expect(limitOf(ctx, 'email_change_user')).toEqual({ max: 5, windowS: 86400 });
    expect(limitOf(ctx, 'number_account')).toEqual({ max: 10, windowS: 86400 });
  });

  it('buckets IPv6 clients by /64 for every per-IP limit (IPv4 whole; mapped IPv4 as IPv4)', () => {
    for (const name of ['signup_ip', 'magic_ip', 'signin_ip'] as const) {
      expect(rateKey(ctx, name, '2001:db8:1:2::1')).toBe(rateKey(ctx, name, '2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
      expect(rateKey(ctx, name, '2001:db8:1:2::1')).not.toBe(rateKey(ctx, name, '2001:db8:1:3::1'));
      expect(rateKey(ctx, name, '::ffff:1.2.3.4')).toBe(rateKey(ctx, name, '1.2.3.4'));
      expect(rateKey(ctx, name, '1.2.3.4')).not.toBe(rateKey(ctx, name, '1.2.3.5'));
    }
    for (let i = 1; i <= 5; i++) expect(hit(ctx, 'signup_ip', `2001:db8:1:2::${i}`).ok).toBe(true);
    expect(hit(ctx, 'signup_ip', '2001:db8:1:2::99').ok).toBe(false); // same /64, sixth sign-up
    expect(hit(ctx, 'signup_ip', '2001:db8:1:3::1').ok).toBe(true); // another /64
  });

  it('does not bucket keys of limits that are not per-IP', () => {
    expect(rateKey(ctx, 'magic_email', 'a::1')).not.toBe(rateKey(ctx, 'magic_email', 'a::2'));
  });

  it('stores only a hash of the key, never the value itself', () => {
    hit(ctx, 'signup_email', 'ada@example.org');
    const rows = ctx.db.select().from(rateEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).not.toContain('ada@example.org');
    expect(rows[0].key).toBe(rateKey(ctx, 'signup_email', 'ada@example.org'));
  });

  it('keys are HMAC’d with the portal secret, so a leaked table can’t be brute-forced back to emails or IPs', () => {
    const withoutSecret = createHash('sha256').update('ada@example.org').digest('hex');
    expect(rateKey(ctx, 'signup_email', 'ada@example.org')).not.toBe(`signup_email:${withoutSecret}`);
    const otherCtx = { ...ctx, config: { ...ctx.config, secret: `${ctx.config.secret}x` } };
    expect(rateKey(otherCtx, 'signup_email', 'ada@example.org')).not.toBe(rateKey(ctx, 'signup_email', 'ada@example.org'));
  });

  it('allows max hits per window per key, then answers with a plain message', () => {
    for (let i = 0; i < 5; i++) expect(hit(ctx, 'signup_ip', '192.0.2.1').ok).toBe(true);
    const sixth = hit(ctx, 'signup_ip', '192.0.2.1');
    expect(sixth).toEqual({
      ok: false,
      message: 'Too many sign-ups from your network. Please try again in about an hour.',
      retryAfterS: 3600,
    });
    expect(hit(ctx, 'signup_ip', '192.0.2.2').ok).toBe(true); // another key
    ctx.clock.t += 3600_000;
    expect(hit(ctx, 'signup_ip', '192.0.2.1').ok).toBe(true); // the window slid past
  });

  it('does not count refused attempts', () => {
    for (let i = 0; i < 3; i++) hit(ctx, 'signup_email', 'a@example.org');
    for (let i = 0; i < 10; i++) expect(hit(ctx, 'signup_email', 'a@example.org').ok).toBe(false);
    ctx.clock.t += 86400_000;
    expect(hit(ctx, 'signup_email', 'a@example.org').ok).toBe(true);
  });

  it('can be adjusted by an admin', () => {
    setLimit(ctx, 'magic_email', 1);
    expect(limitOf(ctx, 'magic_email')).toEqual({ max: 1, windowS: 3600 });
    expect(hit(ctx, 'magic_email', 'a@example.org').ok).toBe(true);
    expect(hit(ctx, 'magic_email', 'a@example.org').ok).toBe(false);
    expect(() => setLimit(ctx, 'magic_email', 0)).toThrow();
  });
});

describe('audit', () => {
  it('records portal actions, newest first', () => {
    writeAudit(ctx, { actorId: 1, action: 'account.signup', target: 'user:1', ip: '192.0.2.1' });
    ctx.clock.t += 1;
    writeAudit(ctx, { actorId: null, action: 'limit.set', detail: { name: 'magic_email', max: 1 } });
    const rows = listAudit(ctx, 10);
    expect(rows.map((r) => r.action)).toEqual(['limit.set', 'account.signup']);
    expect(rows[0].detail).toBe('{"name":"magic_email","max":1}');
    expect(rows[1]).toMatchObject({ actorId: 1, target: 'user:1', ip: '192.0.2.1', at: ctx.clock.t - 1 });
  });
});
