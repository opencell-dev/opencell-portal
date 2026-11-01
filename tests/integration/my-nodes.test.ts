import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, nodeDowntime, nodes, nodeState, userRoles, users } from '@/db/schema';
import { addDowntime, askRetire, cancelDowntime, cellSnapshot, forgetSnapshot, getMyNode, myNodes, newSetupCommand, setAlertsMuted } from '@/lib/nodes/my-nodes';
import { publishRelease } from '@/lib/nodes/release';
import { peekToken } from '@/lib/nodes/setup-tokens';
import { testCtx, type TestCtx } from '../helpers/ctx';

const META = { ip: '203.0.113.9' };
const MIN = 60_000;
const DAY = 86_400_000;

let tgz: string;
beforeAll(() => {
  const d = mkdtempSync(join(tmpdir(), 'oc-rel-'));
  tgz = join(d, 'r.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', 'tests/fixtures/oc-cell-release', '.']);
});
afterAll(() => {});

let ctx: TestCtx;
let alice: number;
let bob: number;
let id: number;
let cellId: number;

const user = (email: string) => ctx.db.insert(users).values({ name: email.split('@')[0], email, emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;

function addNode(userId: number, over: Partial<typeof nodes.$inferInsert> = {}) {
  const cell = ctx.core.simAddCell('roof', 'part15', 0);
  const n = ctx.db.insert(nodes).values({ requestId: 1, userId, coreId: 'fake', cellId: cell, cellName: 'roof', certCn: `cell${cell}-roof`, siteName: 'Roof', lat: 39.414371, lon: -77.410541, region: 'MD', contactPhone: '+13015550100', anchor: 30, cellSeed: 5, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1, certFpr: 'a'.repeat(64), certExpiresAt: ctx.now() + DAY, ...over }).returning().get();
  ctx.db.insert(nodeState).values({ nodeId: n.id, online: null, checkedAt: 1 }).run();
  return n;
}

beforeEach(() => {
  ctx = testCtx({ OC_RELEASE_DIR: mkdtempSync(join(tmpdir(), 'oc-rel-')) });
  alice = user('alice@example.org');
  bob = user('bob@example.org');
  const n = addNode(alice);
  id = n.id;
  cellId = n.cellId;
});

describe('myNodes', () => {
  it('holds only the account’s own nodes', async () => {
    addNode(bob);
    expect((await myNodes(ctx, alice)).map((c) => c.id)).toEqual([id]);
    expect(await getMyNode(ctx, alice, id)).not.toBeNull();
    expect(await getMyNode(ctx, bob, id)).toBeNull();
  });

  it('a node without a certificate waits for setup', async () => {
    ctx.db.update(nodes).set({ certFpr: null, certExpiresAt: null }).where(eq(nodes.id, id)).run();
    const [c] = await myNodes(ctx, alice);
    expect(c).toMatchObject({ state: 'waiting_setup', cert: null, channel: { anchor: 30, mhz: 917.25, reported: false }, mode: 'part15' });
  });

  it('a certificate never heard from waits for the node', async () => {
    expect((await myNodes(ctx, alice))[0]).toMatchObject({ state: 'waiting_setup', cert: { fpr: 'a'.repeat(64) } });
  });

  it('an online node: terminals, calls, the channel it reports, the board’s uptime', async () => {
    ctx.core.simCellOnline(cellId, true);
    ctx.core.simActiveCalls(cellId, 2);
    ctx.core.simSubscriber('+883171746412345', 1, cellId);
    ctx.core.simRadio(cellId, [{ radio: 0, role: 'bs', band: 915, fw: '0.3.0', anchor: 12, pps: 'locked', timebase: true, tempC: 40, boardUptimeS: 3600, reportedAt: ctx.now(), schedules: 1, rach: 0, attach: 0, grants: 0, ackErrors: 0, ackLate: 0, lateSlots: 0, radioErrors: 0, lastRadioError: 0, scheduleMisses: 0, uartCrcErrors: 0, terminalsHeard: 0 }]);
    const [c] = await myNodes(ctx, alice);
    expect(c).toMatchObject({ state: 'online', terminals: 1, calls: 2, boardUptimeS: 3600, channel: { anchor: 12, reported: true }, mode: 'part15', lastHeardAt: ctx.now() });
  });

  it('an offline node', async () => {
    ctx.core.simCellOffline(cellId, ctx.now() - 5 * MIN);
    const [c] = await myNodes(ctx, alice);
    expect(c).toMatchObject({ state: 'offline', lastHeardAt: ctx.now() - 5 * MIN });
  });

  it('a nonsense anchor in a cell’s report does not break the page', async () => {
    ctx.core.simCellOnline(cellId, true);
    ctx.core.simRadio(cellId, [{ radio: 0, role: 'bs', band: 915, fw: '0.3.0', anchor: 200, pps: 'locked', timebase: true, tempC: 40, boardUptimeS: 1, reportedAt: ctx.now(), schedules: 1, rach: 0, attach: 0, grants: 0, ackErrors: 0, ackLate: 0, lateSlots: 0, radioErrors: 0, lastRadioError: 0, scheduleMisses: 0, uartCrcErrors: 0, terminalsHeard: 0 }]);
    expect((await myNodes(ctx, alice))[0].channel).toEqual({ anchor: 30, mhz: 917.25, reported: false });
  });

  it('a core that does not answer leaves it unknown', async () => {
    ctx.core.simDown('refuse');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [c] = await myNodes(ctx, alice);
    log.mockRestore();
    expect(c).toMatchObject({ state: 'unknown', terminals: null, calls: null });
  });

  it('a revoked node', async () => {
    ctx.db.update(nodes).set({ revokedAt: 5 }).where(eq(nodes.id, id)).run();
    expect((await myNodes(ctx, alice))[0].state).toBe('revoked');
  });

  it('shows the live setup token’s expiry, never the token', async () => {
    publishRelease(ctx, tgz, 'v0.2.0');
    expect((await myNodes(ctx, alice))[0].setup).toBeNull();
    const r = newSetupCommand(ctx, alice, id, META);
    if (!r.ok) throw new Error(r.error);
    const [c] = await myNodes(ctx, alice);
    expect(c.setup).toEqual({ expiresAt: r.expiresAt });
    expect(JSON.stringify(c)).not.toContain(r.command.split('/').at(-1)!.split(' ')[0]);
  });

  it('asks the core at most once in 15 s, then again', async () => {
    const asked = () => ctx.core.audit.filter((a) => a.op === 'cell.status').length;
    forgetSnapshot(ctx);
    await myNodes(ctx, alice);
    await myNodes(ctx, alice);
    expect(asked()).toBe(1);
    ctx.clock.t += 15_000;
    await myNodes(ctx, alice);
    expect(asked()).toBe(2);
    expect(ctx.core.audit.filter((a) => a.op === 'cell.status').every((a) => a.actor === 0)).toBe(true);
  });

  it('a snapshot of a core nobody knows is null', async () => {
    expect(await cellSnapshot(ctx, 'nope')).toBeNull();
  });

  it('an old core’s missing cell.radio still gives the cells', async () => {
    const radio = vi.spyOn(ctx.core, 'cellRadio').mockRejectedValue(Object.assign(new Error('x'), { code: 'unsupported', [Symbol.for('opencell.CoreError')]: true }));
    const s = await cellSnapshot(ctx, 'fake');
    radio.mockRestore();
    expect(s?.cells.get(cellId)).toBeDefined();
    expect(s?.radios.size).toBe(0);
  });
});

describe('a new setup command', () => {
  it('is for the owner, voids the one before, offers the new-key form', () => {
    publishRelease(ctx, tgz, 'v0.2.0');
    expect(newSetupCommand(ctx, bob, id, META)).toMatchObject({ ok: false });
    const a = newSetupCommand(ctx, alice, id, META);
    if (!a.ok) throw new Error(a.error);
    const token = /\/setup\/([A-Za-z0-9_-]{43}) /.exec(a.command)![1];
    expect(a.command).toBe(`curl -fsSL https://portal.test/setup/${token} | sudo bash`);
    expect(a.newKeyCommand).toBe(`curl -fsSL https://portal.test/setup/${token} | sudo bash -s -- --new-key`);
    expect(peekToken(ctx, token).ok).toBe(true);
    const b = newSetupCommand(ctx, alice, id, META);
    if (!b.ok) throw new Error(b.error);
    expect(peekToken(ctx, token).ok).toBe(false);
  });

  it('needs a release, and an unrevoked node', () => {
    expect(newSetupCommand(ctx, alice, id, META)).toMatchObject({ ok: false, error: expect.stringContaining('published') });
    publishRelease(ctx, tgz, 'v0.2.0');
    ctx.db.update(nodes).set({ revokedAt: 5 }).where(eq(nodes.id, id)).run();
    expect(newSetupCommand(ctx, alice, id, META).ok).toBe(false);
  });
});

describe('the alert switch', () => {
  it('flips for the owner only', async () => {
    expect(setAlertsMuted(ctx, bob, id, true, META).ok).toBe(false);
    expect((await myNodes(ctx, alice))[0].alertsMuted).toBe(false);
    expect(setAlertsMuted(ctx, alice, id, true, META).ok).toBe(true);
    expect((await myNodes(ctx, alice))[0].alertsMuted).toBe(true);
    expect(setAlertsMuted(ctx, alice, id, false, META).ok).toBe(true);
    expect((await myNodes(ctx, alice))[0].alertsMuted).toBe(false);
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'node.alerts')).all()).toHaveLength(2);
  });
});

describe('downtime notices', () => {
  const window = (over = {}) => ({ startsAt: ctx.now() + 60 * MIN, endsAt: ctx.now() + 120 * MIN, reason: 'Roof work', ...over });

  it('are added by the owner and shown on the card', async () => {
    const r = addDowntime(ctx, alice, id, window(), META);
    expect(r.ok).toBe(true);
    expect((await myNodes(ctx, alice))[0].downtime).toEqual([expect.objectContaining({ reason: 'Roof work', startsAt: ctx.now() + 60 * MIN })]);
    expect(addDowntime(ctx, bob, id, window(), META).ok).toBe(false);
  });

  it.each([
    ['a window in the past', () => ({ startsAt: ctx.now() - 6 * MIN, endsAt: ctx.now() + MIN })],
    ['an end before its start', () => ({ endsAt: ctx.now() + 30 * MIN })],
    ['31 days', () => ({ endsAt: ctx.now() + 60 * MIN + 31 * DAY })],
    ['a short reason', () => ({ reason: 'x' })],
    ['a long reason', () => ({ reason: 'x'.repeat(201) })],
    ['a reason that is not plain', () => ({ reason: 'bad\u0007reason' })],
    ['a start that is no time', () => ({ startsAt: 'soon' })],
  ])('refuses %s', (_w, over) => {
    expect(addDowntime(ctx, alice, id, window(over()), META).ok).toBe(false);
    expect(ctx.db.select().from(nodeDowntime).all()).toEqual([]);
  });

  it('takes a window that began less than 5 minutes ago', () => {
    expect(addDowntime(ctx, alice, id, window({ startsAt: ctx.now() - 4 * MIN }), META).ok).toBe(true);
  });

  it('holds at most 5 future windows', () => {
    for (let i = 0; i < 5; i++) expect(addDowntime(ctx, alice, id, window(), META).ok).toBe(true);
    expect(addDowntime(ctx, alice, id, window(), META)).toMatchObject({ ok: false, error: expect.stringContaining('5') });
  });

  it('can be cancelled by the owner only', async () => {
    addDowntime(ctx, alice, id, window(), META);
    const w = ctx.db.select().from(nodeDowntime).get()!;
    expect(cancelDowntime(ctx, bob, w.id, META).ok).toBe(false);
    expect(cancelDowntime(ctx, alice, w.id, META).ok).toBe(true);
    expect((await myNodes(ctx, alice))[0].downtime).toEqual([]);
    expect(cancelDowntime(ctx, alice, w.id, META).ok).toBe(false);
  });
});

describe('retiring', () => {
  it('mails the admins, for the owner only', async () => {
    const root = user('root@example.org');
    ctx.db.insert(userRoles).values({ userId: root, role: 'admin', grantedAt: 1 }).run();
    expect(askRetire(ctx, bob, id, 'x', META).ok).toBe(false);
    expect(askRetire(ctx, alice, id, 'Moving house.', META).ok).toBe(true);
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent.map((m) => m.to)).toEqual(['root@example.org']);
    expect(ctx.mailer.sent[0].text).toContain('Moving house.');
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'node.retire_ask')).all()).toHaveLength(1);
  });
});
