import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeDowntime, nodes, nodeState, settings, userRoles, users } from '@/db/schema';
import { forgetSnapshot } from '@/lib/nodes/my-nodes';
import { addDowntime, cancelDowntime } from '@/lib/nodes/my-nodes';
import { inDowntime, startNodeWatch, watchTick, WATCH_MS } from '@/lib/nodes/watch';
import { type CellPki, makeCellPki } from '../helpers/cell-pki';
import { testCtx, type TestCtx } from '../helpers/ctx';

const META = { ip: '203.0.113.9' };
const MIN = 60_000;

let ctx: TestCtx;
let alice: number;
let id: number;
let cellId: number;

const user = (email: string) => ctx.db.insert(users).values({ name: email.split('@')[0], email, emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;

function addNode(userId: number | null, over: Partial<typeof nodes.$inferInsert> = {}) {
  const cell = ctx.core.simAddCell('roof', 'part15', 0);
  const n = ctx.db.insert(nodes).values({ requestId: 1, userId, coreId: 'fake', cellId: cell, cellName: 'roof', certCn: `cell${cell}-roof`, siteName: 'Roof', lat: 39.4, lon: -77.4, region: 'MD', contactPhone: '+13015550100', anchor: 30, cellSeed: 5, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1, certFpr: 'a'.repeat(64), certExpiresAt: ctx.now() + 86_400_000, certIssuedAt: ctx.now() - 3_600_000, ...over }).returning().get();
  ctx.db.insert(nodeState).values({ nodeId: n.id, online: null, checkedAt: 1 }).run();
  return n;
}

const state = (nodeId = id) => ctx.db.select().from(nodeState).where(eq(nodeState.nodeId, nodeId)).get()!;

async function mails(to: string) {
  await ctx.mailQueue.drain();
  return ctx.mailer.sent.filter((m) => m.to === to);
}

/** A tick at `t`. */
async function tickAt(t: number) {
  ctx.clock.t = t;
  return watchTick(ctx);
}

beforeEach(() => {
  ctx = testCtx();
  alice = user('alice@example.org');
  const n = addNode(alice);
  id = n.id;
  cellId = n.cellId;
  ctx.core.simCellOnline(cellId, true);
});

describe('the watcher: offline and back mails', () => {
  it('says nothing at +9 min, once at +10 min, nothing more at +20 min; once when back', async () => {
    const t0 = ctx.clock.t;
    await tickAt(t0);
    expect(state()).toMatchObject({ online: true, onlineSince: t0, offlineSince: null });
    ctx.core.simCellOnline(cellId, false);
    let r = await tickAt(t0 + MIN);
    expect(state()).toMatchObject({ online: false, offlineSince: t0, onlineSince: null });
    expect(r.offline).toEqual([]);
    r = await tickAt(t0 + 9 * MIN);
    expect(r.offline).toEqual([]);
    expect(await mails('alice@example.org')).toEqual([]);
    r = await tickAt(t0 + 10 * MIN);
    expect(r.offline).toEqual([id]);
    let sent = await mails('alice@example.org');
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('offline');
    expect(sent[0].text).toContain(`/nodes/${id}`);
    r = await tickAt(t0 + 20 * MIN);
    expect(r.offline).toEqual([]);
    expect(await mails('alice@example.org')).toHaveLength(1);
    ctx.core.simCellOnline(cellId, true);
    r = await tickAt(t0 + 21 * MIN);
    expect(r.back).toEqual([id]);
    sent = await mails('alice@example.org');
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toContain('back');
    expect(state()).toMatchObject({ online: true, onlineSince: t0 + 21 * MIN, offlineSince: null, offlineAlertAt: null });
    r = await tickAt(t0 + 22 * MIN);
    expect(r.back).toEqual([]);
  });

  it('a short outage says nothing either way', async () => {
    const t0 = ctx.clock.t;
    await tickAt(t0);
    ctx.core.simCellOnline(cellId, false);
    await tickAt(t0 + MIN);
    ctx.core.simCellOnline(cellId, true);
    const r = await tickAt(t0 + 2 * MIN);
    expect(r.back).toEqual([]);
    expect(await mails('alice@example.org')).toEqual([]);
  });

  it('a node flapping every minute sends nothing: it is never offline for 10 minutes', async () => {
    let t = ctx.clock.t;
    for (let i = 0; i < 40; i++) {
      ctx.core.simCellOnline(cellId, i % 2 === 1);
      t += MIN;
      await tickAt(t);
    }
    expect(await mails('alice@example.org')).toEqual([]);
  });

  it('counts from when the core last heard it, if that is earlier', async () => {
    const t0 = ctx.clock.t;
    ctx.core.simCellOffline(cellId, t0 - 30 * MIN);
    await tickAt(t0);
    expect(state().offlineSince).toBe(t0 - 30 * MIN);
    expect((await mails('alice@example.org'))).toHaveLength(1);
  });

  it('a new certificate starts the count again', async () => {
    const t0 = ctx.clock.t;
    ctx.core.simCellOffline(cellId, t0 - 3 * 86_400_000);
    ctx.db.update(nodes).set({ certIssuedAt: t0 }).where(eq(nodes.id, id)).run();
    await tickAt(t0);
    expect(state().offlineSince).toBe(t0);
    expect(await mails('alice@example.org')).toEqual([]);
  });

  it('a muted node sends nothing, either way', async () => {
    ctx.db.update(nodes).set({ alertsMuted: true }).where(eq(nodes.id, id)).run();
    const t0 = ctx.clock.t;
    await tickAt(t0);
    ctx.core.simCellOnline(cellId, false);
    await tickAt(t0 + MIN);
    await tickAt(t0 + 11 * MIN);
    ctx.core.simCellOnline(cellId, true);
    await tickAt(t0 + 12 * MIN);
    expect(await mails('alice@example.org')).toEqual([]);
  });

  it('a node without a certificate, or revoked, is never alerted', async () => {
    const t0 = ctx.clock.t;
    const none = addNode(alice, { certFpr: null });
    const gone = addNode(alice, { revokedAt: 1 });
    ctx.core.simCellOffline(none.cellId, t0 - 60 * MIN);
    ctx.core.simCellOffline(gone.cellId, t0 - 60 * MIN);
    const r = await tickAt(t0);
    expect(r.offline).toEqual([]);
    expect(state(none.id).online).toBeNull();
    expect(state(gone.id).online).toBeNull();
    expect(await mails('alice@example.org')).toEqual([]);
  });

  it('a node with no operator: state, no mail', async () => {
    const t0 = ctx.clock.t;
    const n = addNode(null);
    ctx.core.simCellOffline(n.cellId, t0 - 60 * MIN);
    await tickAt(t0);
    expect(state(n.id).online).toBe(false);
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent).toEqual([]);
  });

  it('a core outage is unknown, and no mail', async () => {
    const t0 = ctx.clock.t;
    await tickAt(t0);
    ctx.core.simDown('refuse');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await tickAt(t0 + 60 * MIN);
    log.mockRestore();
    expect(r.offline).toEqual([]);
    expect(state().online).toBeNull();
    expect(state().onlineSince).toBe(t0);
    expect(await mails('alice@example.org')).toEqual([]);
    // Still online afterwards: uptime carries on; no mail.
    ctx.core.simDown(null);
    await tickAt(t0 + 61 * MIN);
    expect(state()).toMatchObject({ online: true, onlineSince: t0 });
  });
});

describe('the watcher and downtime notices', () => {
  it('stays quiet inside a window, and counts 10 minutes again from its end', async () => {
    const t0 = ctx.clock.t;
    await tickAt(t0);
    expect(addDowntime(ctx, alice, id, { startsAt: t0, endsAt: t0 + 60 * MIN, reason: 'Roof work' }, META).ok).toBe(true);
    expect(inDowntime(ctx, id, t0 + MIN)).toEqual({ endsAt: t0 + 60 * MIN });
    expect(inDowntime(ctx, id, t0 + 60 * MIN)).toBeNull();
    ctx.core.simCellOnline(cellId, false);
    for (const m of [1, 11, 30, 59, 60, 65, 69]) {
      const r = await tickAt(t0 + m * MIN);
      expect(r.offline, `at +${m} min`).toEqual([]);
    }
    expect(await mails('alice@example.org')).toEqual([]);
    const r = await tickAt(t0 + 70 * MIN);
    expect(r.offline).toEqual([id]);
    expect(await mails('alice@example.org')).toHaveLength(1);
  });

  it('a window begun after the alert: no back mail inside it', async () => {
    const t0 = ctx.clock.t;
    await tickAt(t0);
    ctx.core.simCellOnline(cellId, false);
    await tickAt(t0 + MIN);
    await tickAt(t0 + 11 * MIN);
    expect(await mails('alice@example.org')).toHaveLength(1);
    addDowntime(ctx, alice, id, { startsAt: t0 + 11 * MIN, endsAt: t0 + 60 * MIN, reason: 'Roof work' }, META);
    ctx.core.simCellOnline(cellId, true);
    await tickAt(t0 + 12 * MIN);
    expect(await mails('alice@example.org')).toHaveLength(1);
    expect(state().offlineAlertAt).toBeNull();
  });

  it('a cancelled window does not count', async () => {
    const t0 = ctx.clock.t;
    await tickAt(t0);
    addDowntime(ctx, alice, id, { startsAt: t0, endsAt: t0 + 60 * MIN, reason: 'Roof work' }, META);
    const w = ctx.db.select().from(nodeDowntime).get()!;
    cancelDowntime(ctx, alice, w.id, META);
    expect(inDowntime(ctx, id, t0 + MIN)).toBeNull();
    ctx.core.simCellOnline(cellId, false);
    await tickAt(t0 + MIN);
    const r = await tickAt(t0 + 11 * MIN);
    expect(r.offline).toEqual([id]);
  });
});

describe('the admins’ digest', () => {
  let root: number;
  // 2026-07-15 and a NY offset of -4.
  const at = (h: number, day = 15, month = 6, offset = 4) => Date.UTC(2026, month, day, h + offset, 0);

  beforeEach(() => {
    root = user('root@example.org');
    ctx.db.insert(userRoles).values({ userId: root, role: 'admin', grantedAt: 1 }).run();
    ctx.db.update(nodes).set({ alertsMuted: true }).where(eq(nodes.id, id)).run();
  });

  const digests = async () => (await mails('root@example.org')).filter((m) => m.subject.includes('offline'));

  it('goes out once a day from 08:00 New York time, when a node is offline', async () => {
    ctx.core.simCellOffline(cellId, at(1));
    let r = await tickAt(at(7));
    expect(r.digest).toBe(false);
    r = await tickAt(at(8));
    expect(r.digest).toBe(true);
    let sent = await digests();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Roof');
    expect(sent[0].text).toContain(`Node ${id}`);
    r = await tickAt(at(9));
    expect(r.digest).toBe(false);
    r = await tickAt(at(23));
    expect(r.digest).toBe(false);
    sent = await digests();
    expect(sent).toHaveLength(1);
    r = await tickAt(at(8, 16));
    expect(r.digest).toBe(true);
    expect(await digests()).toHaveLength(2);
    expect(ctx.db.select().from(settings).where(eq(settings.key, 'nodes:digest_day')).get()?.value).toBe('2026-07-16');
  });

  it('sends nothing on a day with nothing offline', async () => {
    ctx.core.simCellOnline(cellId, true);
    const r = await tickAt(at(8));
    expect(r.digest).toBe(false);
    expect(await digests()).toEqual([]);
  });

  it('a node in downtime is left out of it', async () => {
    ctx.core.simCellOffline(cellId, at(1));
    ctx.clock.t = at(7);
    addDowntime(ctx, alice, id, { startsAt: at(7), endsAt: at(12), reason: 'Roof work' }, META);
    const r = await tickAt(at(8));
    expect(r.digest).toBe(false);
  });

  it('follows daylight saving: March and November', async () => {
    ctx.core.simCellOffline(cellId, Date.UTC(2026, 0, 1));
    // 2026-03-07 is still EST (-5); 12:59 UTC is 07:59 local, 13:00 UTC is 08:00.
    expect((await tickAt(Date.UTC(2026, 2, 7, 12, 59))).digest).toBe(false);
    expect((await tickAt(Date.UTC(2026, 2, 7, 13, 0))).digest).toBe(true);
    // 2026-03-09 is EDT (-4): 11:59 UTC is 07:59; 12:00 UTC is 08:00.
    expect((await tickAt(Date.UTC(2026, 2, 9, 11, 59))).digest).toBe(false);
    expect((await tickAt(Date.UTC(2026, 2, 9, 12, 0))).digest).toBe(true);
    // 2026-11-01 is the day the clocks go back: 08:00 EST is 13:00 UTC.
    expect((await tickAt(Date.UTC(2026, 10, 1, 12, 59))).digest).toBe(false);
    expect((await tickAt(Date.UTC(2026, 10, 1, 13, 0))).digest).toBe(true);
  });
});

describe('the intermediate’s expiry', () => {
  let pki: CellPki;
  beforeEach(() => {
    pki = makeCellPki();
  });

  it('warns the admins once a day from 30 days before it ends', async () => {
    const c = testCtx({ OC_CELL_CA_CERT: pki.icaCrt, OC_CELL_CA_KEY: pki.icaKey });
    const r0 = c.db.insert(users).values({ name: 'Root', email: 'root@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
    c.db.insert(userRoles).values({ userId: r0, role: 'admin', grantedAt: 1 }).run();
    const { loadCellCa } = await import('@/lib/ca/cell-ca');
    const end = loadCellCa(c)!.notAfter;
    c.clock.t = end - 31 * 86_400_000;
    expect((await watchTick(c)).icaWarned).toBe(false);
    c.clock.t = end - 29 * 86_400_000;
    expect((await watchTick(c)).icaWarned).toBe(true);
    c.clock.t += 3_600_000;
    expect((await watchTick(c)).icaWarned).toBe(false);
    c.clock.t += 86_400_000;
    expect((await watchTick(c)).icaWarned).toBe(true);
    await c.mailQueue.drain();
    expect(c.mailer.sent.filter((m) => m.to === 'root@example.org')).toHaveLength(2);
    expect(c.mailer.sent[0].text).toContain('oc-portal-cell-ca renew');
    pki.done();
  });

  it('says nothing when there is none', async () => {
    expect((await watchTick(ctx)).icaWarned).toBe(false);
    pki.done();
  });
});

describe('startNodeWatch', () => {
  it('first ticks after 30 s, then every period; a slow tick is not run twice; it stops', async () => {
    vi.useFakeTimers();
    try {
      const c = testCtx();
      const status = vi.spyOn(c.core, 'cellStatus');
      const cellId2 = c.core.simAddCell('x', 'part15', 0);
      c.db.insert(nodes).values({ requestId: 1, coreId: 'fake', cellId: cellId2, cellName: 'x', certCn: 'x', siteName: 'x', lat: 39, lon: -77, region: 'MD', contactPhone: 'x', anchor: 0, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1, certFpr: 'b'.repeat(64) }).run();
      forgetSnapshot(c);
      const stop = startNodeWatch(c);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(status).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(status).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(WATCH_MS);
      expect(status).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(5 * WATCH_MS);
      expect(status).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a tick while one is running, and logs a failure by its class only', async () => {
    vi.useFakeTimers();
    try {
      const c = testCtx();
      const cell = c.core.simAddCell('x', 'part15', 0);
      c.db.insert(nodes).values({ requestId: 1, coreId: 'fake', cellId: cell, cellName: 'x', certCn: 'x', siteName: 'x', lat: 39, lon: -77, region: 'MD', contactPhone: 'x', anchor: 0, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1, certFpr: 'b'.repeat(64) }).run();
      let release = () => {};
      const status = vi.spyOn(c.core, 'cellStatus').mockImplementation(() => new Promise((res) => {
        release = () => res([]);
      }));
      const stop = startNodeWatch(c, 1000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(status).toHaveBeenCalledTimes(1);
      // The core has not answered (3 s to give up): the next ticks are skipped.
      await vi.advanceTimersByTimeAsync(2_500);
      expect(status).toHaveBeenCalledTimes(1);
      release();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
