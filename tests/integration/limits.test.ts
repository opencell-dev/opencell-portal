import { beforeEach, describe, expect, it } from 'vitest';
import { users } from '@/db/schema';
import { listAudit } from '@/lib/audit';
import { decideLimitRequest, pendingLimitRequests, pendingRequestOf, requestMoreNumbers } from '@/lib/numbers/limits';
import { grantRole } from '@/lib/users';
import { type TestCtx, testCtx } from '../helpers/ctx';

const meta = { ip: '192.0.2.10' };
let ctx: TestCtx;
let ada: number;
let root: number;

function user(name: string) {
  return ctx.db.insert(users).values({ name, email: `${name}@example.org`, emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
}

beforeEach(() => {
  ctx = testCtx();
  ada = user('ada');
  root = user('root');
  grantRole(ctx, root, 'admin', null);
});

const REASON = 'A second terminal for the car, and one for the shack.';

describe('requests for more numbers (spec §4.2: above 3, a short reason, and an admin raises the limit)', () => {
  it('a request: stored, the admins mailed, audited; one pending at a time', async () => {
    expect(requestMoreNumbers(ctx, ada, { reason: REASON, wanted: '5' }, meta)).toEqual({ ok: true });
    await ctx.mailQueue.drain();
    expect(pendingRequestOf(ctx, ada)).toMatchObject({ reason: REASON, wanted: 5 });
    const mails = ctx.mailer.sent.filter((m) => m.to === 'root@example.org');
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain(REASON);
    expect(mails[0].text).toContain('/admin/limits');
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: ada, action: 'limit.request' });
    expect(requestMoreNumbers(ctx, ada, { reason: REASON, wanted: '5' }, meta)).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
  });

  it('checks the reason and the number', () => {
    expect(requestMoreNumbers(ctx, ada, { reason: 'short', wanted: '4' }, meta)).toMatchObject({ ok: false, error: expect.stringMatching(/10/) });
    expect(requestMoreNumbers(ctx, ada, { reason: 'x'.repeat(501), wanted: '4' }, meta)).toMatchObject({ ok: false, error: expect.stringMatching(/500/) });
    expect(requestMoreNumbers(ctx, ada, { reason: `${REASON}‮`, wanted: '4' }, meta)).toMatchObject({ ok: false, error: expect.stringMatching(/plain text/) });
    expect(requestMoreNumbers(ctx, ada, { reason: REASON, wanted: '3' }, meta)).toMatchObject({ ok: false });
    expect(requestMoreNumbers(ctx, ada, { reason: REASON, wanted: '21' }, meta)).toMatchObject({ ok: false });
    expect(requestMoreNumbers(ctx, ada, { reason: `line one is fine\nline two too`, wanted: '4' }, meta)).toEqual({ ok: true });
  });

  it('raise: the limit goes up, the subscriber is mailed, the request is closed', async () => {
    requestMoreNumbers(ctx, ada, { reason: REASON, wanted: '5' }, meta);
    const [p] = pendingLimitRequests(ctx);
    expect(p).toMatchObject({ userId: ada, name: 'ada', email: 'ada@example.org', held: 0, limit: 3, wanted: 5, verified: true });
    expect(decideLimitRequest(ctx, root, p.id, { outcome: 'raised', limit: 5 }, meta)).toEqual({ ok: true });
    await ctx.mailQueue.drain();
    expect(ctx.db.select().from(users).all().find((u) => u.id === ada)?.numberLimit).toBe(5);
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ to: 'ada@example.org', subject: 'OpenCell: you can hold more numbers' });
    expect(pendingLimitRequests(ctx)).toEqual([]);
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: root, action: 'limit.decide', target: `user:${ada}` });
    // Decided once only.
    expect(decideLimitRequest(ctx, root, p.id, { outcome: 'raised', limit: 6 }, meta)).toMatchObject({ ok: false });
    // A new request is possible once the last is decided.
    expect(requestMoreNumbers(ctx, ada, { reason: REASON, wanted: '6' }, meta)).toEqual({ ok: true });
  });

  it('decline: the limit stays, the note goes to the subscriber', async () => {
    requestMoreNumbers(ctx, ada, { reason: REASON, wanted: '5' }, meta);
    const [p] = pendingLimitRequests(ctx);
    expect(decideLimitRequest(ctx, root, p.id, { outcome: 'declined', note: '' }, meta)).toMatchObject({ ok: false });
    expect(decideLimitRequest(ctx, root, p.id, { outcome: 'declined', note: 'Not while the network is this small.' }, meta)).toEqual({ ok: true });
    await ctx.mailQueue.drain();
    expect(ctx.db.select().from(users).all().find((u) => u.id === ada)?.numberLimit).toBe(3);
    expect(ctx.mailer.sent.at(-1)?.text).toContain('Not while the network is this small.');
  });

  it('a raise must be above the current limit and at most 20', () => {
    requestMoreNumbers(ctx, ada, { reason: REASON, wanted: '5' }, meta);
    const [p] = pendingLimitRequests(ctx);
    expect(decideLimitRequest(ctx, root, p.id, { outcome: 'raised', limit: 3 }, meta)).toMatchObject({ ok: false });
    expect(decideLimitRequest(ctx, root, p.id, { outcome: 'raised', limit: 21 }, meta)).toMatchObject({ ok: false });
    expect(decideLimitRequest(ctx, root, 9999, { outcome: 'raised', limit: 5 }, meta)).toMatchObject({ ok: false });
  });
});
