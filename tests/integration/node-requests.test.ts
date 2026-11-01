import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agreementAcceptances, audit, nodeRequests, userRoles, users } from '@/db/schema';
import { getMyRequest, listMyRequests, postMessage, submitRequest, withdrawRequest } from '@/lib/nodes/requests';
import { testCtx, type TestCtx } from '../helpers/ctx';

const META = { ip: '203.0.113.9' };
const GOOD = {
  siteName: 'Frederick Roof',
  lat: '39.414371',
  lon: '-77.410541',
  region: 'MD',
  piModel: 'pi5',
  w12Boards: '1',
  gps: true,
  antenna: 'Vertical on the roof',
  backhaul: 'home',
  power: 'mains_battery',
  contactPhone: '+1 (301) 555-0100',
  agree: true,
  agreementVersion: 1,
};

function user(ctx: TestCtx, email: string, verified = true) {
  return ctx.db.insert(users).values({ name: email.split('@')[0], email, emailVerifiedAt: verified ? 1 : null, createdAt: 1 }).returning().get().id;
}

function admin(ctx: TestCtx, email = 'root@example.org') {
  const id = user(ctx, email);
  ctx.db.insert(userRoles).values({ userId: id, role: 'admin', grantedAt: 1 }).run();
  return id;
}

async function drain(ctx: TestCtx) {
  await ctx.mailQueue.drain();
}

describe('asking for a base station', () => {
  let ctx: TestCtx;
  let a: number;
  beforeEach(() => {
    ctx = testCtx();
    a = user(ctx, 'alice@example.org');
  });

  it('stores the request, the agreement and tells the admins', async () => {
    admin(ctx);
    const r = submitRequest(ctx, a, GOOD, META);
    expect(r.ok).toBe(true);
    const row = ctx.db.select().from(nodeRequests).get()!;
    expect(row).toMatchObject({ userId: a, siteName: 'Frederick Roof', lat: 39.414371, lon: -77.410541, region: 'MD', piModel: 'pi5', w12Boards: 1, gps: true, status: 'pending', agreementVersion: 1, agreedAt: ctx.clock.t });
    expect(ctx.db.select().from(agreementAcceptances).all()).toEqual([expect.objectContaining({ userId: a, version: 1, ip: META.ip })]);
    await drain(ctx);
    const mail = ctx.mailer.sent.find((m) => m.to === 'root@example.org')!;
    expect(mail.subject).toContain('base station');
    expect(mail.text).toContain(`/admin/requests/${row.id}`);
    // The contact phone and the exact pin stay on the admin page.
    expect(mail.text).not.toContain('555-0100');
    expect(mail.text).not.toContain('39.414371');
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'node.request')).all()).toHaveLength(1);
  });

  it('refuses an unverified account', () => {
    const u = user(ctx, 'new@example.org', false);
    const r = submitRequest(ctx, u, GOOD, META);
    expect(r).toMatchObject({ ok: false });
    expect(ctx.db.select().from(nodeRequests).all()).toEqual([]);
  });

  it('refuses a third open request', () => {
    expect(submitRequest(ctx, a, GOOD, META).ok).toBe(true);
    expect(submitRequest(ctx, a, GOOD, META).ok).toBe(true);
    const r = submitRequest(ctx, a, GOOD, META);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('2') });
  });

  it('refuses a fourth in a day with the rate message', () => {
    for (let i = 0; i < 3; i++) {
      const r = submitRequest(ctx, a, GOOD, META);
      if (!r.ok) throw new Error(r.error);
      expect(withdrawRequest(ctx, a, r.id, META).ok).toBe(true);
    }
    expect(submitRequest(ctx, a, GOOD, META)).toMatchObject({ ok: false, error: expect.stringContaining('today') });
  });

  it.each([
    ['contactPhone', 'abc', 'phone'],
    ['lat', '10', 'latitude'],
    ['lon', '0', 'longitude'],
    ['region', 'ZZ', 'state'],
    ['siteName', 'x', 'site name'],
    ['siteName', 'a‮b cdef', 'plain'],
    ['antenna', 'x', 'antenna'],
    ['piModel', 'pi9', 'Pi'],
    ['backhaul', 'carrier pigeon', 'internet'],
    ['power', 'wind', 'power'],
    ['w12Boards', '9', 'boards'],
  ])('refuses %s = %j, saying why', (field, value, word) => {
    const r = submitRequest(ctx, a, { ...GOOD, [field]: value }, META);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error.toLowerCase()).toContain(word.toLowerCase());
    expect(ctx.db.select().from(nodeRequests).all()).toEqual([]);
  });

  it('refuses an unticked agreement or an old version, and stores nothing', () => {
    expect(submitRequest(ctx, a, { ...GOOD, agree: false }, META).ok).toBe(false);
    expect(submitRequest(ctx, a, { ...GOOD, agreementVersion: 0 }, META).ok).toBe(false);
    expect(ctx.db.select().from(nodeRequests).all()).toEqual([]);
    expect(ctx.db.select().from(agreementAcceptances).all()).toEqual([]);
  });

  it('is refused on the NOC site', () => {
    const noc = testCtx({ OC_SITE: 'noc' });
    const u = user(noc, 'x@example.org');
    expect(submitRequest(noc, u, GOOD, META).ok).toBe(false);
  });

  it('shows a request to its owner only', () => {
    const b = user(ctx, 'bob@example.org');
    const r = submitRequest(ctx, a, GOOD, META);
    if (!r.ok) throw new Error(r.error);
    expect(getMyRequest(ctx, a, r.id)?.siteName).toBe('Frederick Roof');
    expect(getMyRequest(ctx, b, r.id)).toBeNull();
    expect(listMyRequests(ctx, a)).toHaveLength(1);
    expect(listMyRequests(ctx, b)).toEqual([]);
  });

  it('lets only the owner withdraw, while it is open', () => {
    const b = user(ctx, 'bob@example.org');
    const r = submitRequest(ctx, a, GOOD, META);
    if (!r.ok) throw new Error(r.error);
    expect(withdrawRequest(ctx, b, r.id, META).ok).toBe(false);
    expect(withdrawRequest(ctx, a, r.id, META).ok).toBe(true);
    expect(getMyRequest(ctx, a, r.id)?.status).toBe('withdrawn');
    expect(withdrawRequest(ctx, a, r.id, META).ok).toBe(false);
  });
});

describe('the request thread', () => {
  let ctx: TestCtx;
  let a: number;
  let root: number;
  let id: number;
  beforeEach(() => {
    ctx = testCtx();
    a = user(ctx, 'alice@example.org');
    root = admin(ctx);
    const r = submitRequest(ctx, a, GOOD, META);
    if (!r.ok) throw new Error(r.error);
    id = r.id;
  });

  it('an admin message sets the status to question and mails the requester', async () => {
    await drain(ctx);
    ctx.mailer.sent.length = 0;
    const r = postMessage(ctx, { requestId: id, authorId: root, fromAdmin: true, body: 'Which antenna height?' }, META);
    expect(r.ok).toBe(true);
    expect(getMyRequest(ctx, a, id)?.status).toBe('question');
    await drain(ctx);
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0].to).toBe('alice@example.org');
    expect(ctx.mailer.sent[0].text).toContain('Which antenna height?');
    expect(ctx.mailer.sent[0].text).toContain(`/nodes/requests/${id}`);
  });

  it('the requester’s reply puts it back to pending and mails the admins', async () => {
    postMessage(ctx, { requestId: id, authorId: root, fromAdmin: true, body: 'Which antenna height?' }, META);
    await drain(ctx);
    ctx.mailer.sent.length = 0;
    const r = postMessage(ctx, { requestId: id, authorId: a, fromAdmin: false, body: 'Ten metres.\nOn the mast.' }, META);
    expect(r.ok).toBe(true);
    const got = getMyRequest(ctx, a, id)!;
    expect(got.status).toBe('pending');
    expect(got.thread.map((m) => [m.fromAdmin, m.body])).toEqual([
      [true, 'Which antenna height?'],
      [false, 'Ten metres.\nOn the mast.'],
    ]);
    await drain(ctx);
    expect(ctx.mailer.sent.map((m) => m.to)).toEqual(['root@example.org']);
    expect(ctx.mailer.sent[0].text).toContain(`/admin/requests/${id}`);
  });

  it('refuses someone else’s reply', () => {
    const b = user(ctx, 'bob@example.org');
    expect(postMessage(ctx, { requestId: id, authorId: b, fromAdmin: false, body: 'Hello' }, META).ok).toBe(false);
    expect(getMyRequest(ctx, a, id)!.thread).toEqual([]);
  });

  it.each(['', '   ', 'x'.repeat(2001), 'bad\u0007line'])('refuses a body like %j', (body) => {
    expect(postMessage(ctx, { requestId: id, authorId: a, fromAdmin: false, body }, META).ok).toBe(false);
  });

  it('refuses a message on a closed request or a missing one', () => {
    expect(withdrawRequest(ctx, a, id, META).ok).toBe(true);
    expect(postMessage(ctx, { requestId: id, authorId: a, fromAdmin: false, body: 'Hello' }, META).ok).toBe(false);
    expect(postMessage(ctx, { requestId: 999, authorId: root, fromAdmin: true, body: 'Hello' }, META).ok).toBe(false);
  });

  it('limits messages per account per hour', () => {
    for (let i = 0; i < 20; i++) expect(postMessage(ctx, { requestId: id, authorId: a, fromAdmin: false, body: `m${i}` }, META).ok).toBe(true);
    expect(postMessage(ctx, { requestId: id, authorId: a, fromAdmin: false, body: 'one more' }, META)).toMatchObject({ ok: false });
  });
});
