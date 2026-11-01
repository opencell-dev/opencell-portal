import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, nodeRequests, nodes, nodeState, rateCenters, settings, setupTokens, userRoles, users } from '@/db/schema';
import { rolesOf } from '@/lib/users';
import { submitRequest } from '@/lib/nodes/requests';
import { approveRequest, declineRequest, reviewDetail, reviewQueue } from '@/lib/nodes/review';
import { claimToken, makeSetupToken, peekToken, releaseClaim, SETUP_TOKEN_MS, setupCommand, TOKEN_RE } from '@/lib/nodes/setup-tokens';
import { testCtx, type TestCtx } from '../helpers/ctx';

const META = { ip: '203.0.113.9' };
const GOOD = { siteName: 'Frederick Roof', lat: '39.414371', lon: '-77.410541', region: 'MD', piModel: 'pi5', w12Boards: '1', gps: true, antenna: 'Vertical', backhaul: 'home', power: 'mains', contactPhone: '+13015550100', agree: true, agreementVersion: 1 };
const OPTS = { coreId: 'fake', anchor: 3, boardRole: 'bs' };

const state: { ctx?: TestCtx; admin: boolean; fresh: boolean } = { admin: true, fresh: true };
vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/server/request', () => ({
  requireAdmin: async () => {
    if (!state.admin) throw new Error('NEXT_NOT_FOUND');
    return { user: { id: 1 } };
  },
  freshAdmin: async () => {
    if (!state.admin) throw new Error('NEXT_NOT_FOUND');
    return state.fresh ? { ok: true, s: { user: { id: 1 } } } : { ok: false, reauth: true };
  },
  requestMeta: async () => META,
}));
const { approveAction, askAction, declineAction } = await import('@/app/actions/admin-nodes');

function user(ctx: TestCtx, email: string) {
  return ctx.db.insert(users).values({ name: email.split('@')[0], email, emailVerifiedAt: 1000, createdAt: 500 }).returning().get().id;
}

function setRelease(ctx: TestCtx) {
  const dir = ctx.config.releaseDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'oc-cell-v0.2.0.tgz'), 'tarball');
  ctx.db.insert(settings).values({ key: 'cell_release', value: JSON.stringify({ tag: 'v0.2.0', sha256: 'a'.repeat(64), bytes: 7 }) }).run();
}

let ctx: TestCtx;
let root: number;
let alice: number;
let id: number;

beforeEach(() => {
  ctx = testCtx({ OC_RELEASE_DIR: mkdtempSync(join(tmpdir(), 'oc-rel-')) });
  state.ctx = ctx;
  state.admin = true;
  state.fresh = true;
  root = user(ctx, 'root@example.org');
  ctx.db.insert(userRoles).values({ userId: root, role: 'admin', grantedAt: 1 }).run();
  alice = user(ctx, 'alice@example.org');
  const r = submitRequest(ctx, alice, GOOD, META);
  if (!r.ok) throw new Error(r.error);
  id = r.id;
});

const mailsTo = async (to: string) => {
  await ctx.mailQueue.drain();
  return ctx.mailer.sent.filter((m) => m.to === to);
};

describe('the queue and the detail', () => {
  it('lists open requests, oldest first, and no closed ones', () => {
    ctx.clock.t += 1000;
    const r2 = submitRequest(ctx, alice, { ...GOOD, siteName: 'Second' }, META);
    if (!r2.ok) throw new Error(r2.error);
    expect(reviewQueue(ctx).map((q) => q.siteName)).toEqual(['Frederick Roof', 'Second']);
    expect(reviewQueue(ctx)[0]).toMatchObject({ id, region: 'MD', status: 'pending', requester: expect.stringContaining('alice') });
    ctx.db.update(nodeRequests).set({ status: 'declined' }).where(eq(nodeRequests.id, id)).run();
    expect(reviewQueue(ctx).map((q) => q.id)).toEqual([r2.id]);
  });

  it('shows what spec §6.2 lists', () => {
    const d = reviewDetail(ctx, id)!;
    expect(d.request).toMatchObject({ lat: 39.414371, lon: -77.410541, contactPhone: '+13015550100', agreementVersion: 1 });
    expect(d.requester).toMatchObject({ id: alice, name: 'alice', email: 'alice@example.org', verifiedAt: 1000, since: 500, numbers: 0, activated: 0, disabled: false });
    expect(d.requester.requests.pending).toBe(1);
    expect(d.nearestNode).toBeNull();
    expect(d.rateCenter).toBeNull();
    expect(d.target).toMatchObject({ coreId: 'fake', side: 'east', note: null });
    expect(d.cores).toEqual([{ id: 'fake', cellAddr: 'cells.fake.invalid:7443' }]);
    expect(d.suggestedAnchor).toBe(0);
    expect(d.thread).toEqual([]);
    expect(reviewDetail(ctx, 999)).toBeNull();
  });

  it('flags a pin nearest to a rate center in another state', () => {
    ctx.db.insert(rateCenters).values({ region: 'PA', name: 'GETTYSBURG', display: 'Gettysburg', lat: 39.83, lon: -77.23 }).run();
    expect(reviewDetail(ctx, id)!.rateCenter).toMatchObject({ region: 'PA', name: 'Gettysburg', matches: false });
    ctx.db.insert(rateCenters).values({ region: 'MD', name: 'FREDERICK', display: 'Frederick', lat: 39.41, lon: -77.41 }).run();
    expect(reviewDetail(ctx, id)!.rateCenter).toMatchObject({ region: 'MD', matches: true });
  });

  it('suggests an anchor nobody uses', async () => {
    const r = await approveRequest(ctx, root, id, { ...OPTS, anchor: 0 }, META);
    expect(r.ok).toBe(true);
    const r2 = submitRequest(ctx, alice, { ...GOOD, siteName: 'Other' }, META);
    if (!r2.ok) throw new Error(r2.error);
    const d = reviewDetail(ctx, r2.id)!;
    expect(d.suggestedAnchor).toBe(1);
    expect(d.nearestNode).toMatchObject({ cellName: `md-${id}`, km: 0 });
  });
});

describe('approving', () => {
  it('makes one cell in Part 15, group 0, the node, the operator role; with a release, a token and the command by mail', async () => {
    setRelease(ctx);
    const r = await approveRequest(ctx, root, id, OPTS, META);
    expect(r).toMatchObject({ ok: true, cellId: 1, tokenMade: true });
    expect(ctx.core.audit.filter((a) => a.op === 'cell.add')).toEqual([expect.objectContaining({ actor: root, arg: `md-${id}` })]);
    expect((await ctx.core.cellStatus(0))[0]).toMatchObject({ cellId: 1, name: `md-${id}`, mode: 'part15', group: 0 });
    const n = ctx.db.select().from(nodes).get()!;
    expect(n).toMatchObject({ requestId: id, userId: alice, coreId: 'fake', cellId: 1, cellName: `md-${id}`, certCn: `cell1-md-${id}`, siteName: 'Frederick Roof', lat: 39.414371, lon: -77.410541, region: 'MD', contactPhone: '+13015550100', anchor: 3, boardRole: 'bs', mode: 'part15', listGroup: 0, certFpr: null, revokedAt: null });
    expect(n.cellSeed).toBeGreaterThan(0);
    expect(ctx.db.select().from(nodeState).get()).toMatchObject({ nodeId: n.id, online: null });
    expect(ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, id)).get()).toMatchObject({ status: 'approved', decidedBy: root, nodeId: n.id });
    expect(rolesOf(ctx, alice)).toContain('operator');
    const [mail] = await mailsTo('alice@example.org');
    expect(mail.subject).toContain('approved');
    const cmd = /curl -fsSL https:\/\/portal\.test\/setup\/([A-Za-z0-9_-]{43}) \| sudo bash/.exec(mail.text);
    expect(cmd).not.toBeNull();
    expect(ctx.db.select().from(setupTokens).get()?.id).not.toContain(cmd![1]);
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'node.approve')).get()?.detail).toBe(JSON.stringify({ core: 'fake', cell: 1, anchor: 3 }));
  });

  it('without a release: the cell, no token, and the mail says setup opens later', async () => {
    const r = await approveRequest(ctx, root, id, OPTS, META);
    expect(r).toMatchObject({ ok: true, tokenMade: false });
    expect(ctx.db.select().from(setupTokens).all()).toEqual([]);
    const [mail] = await mailsTo('alice@example.org');
    expect(mail.text).not.toContain('curl');
    expect(mail.text).toContain('Setup opens when the cell software is published');
  });

  it('a second approve finds it decided, and makes no second cell', async () => {
    expect((await approveRequest(ctx, root, id, OPTS, META)).ok).toBe(true);
    expect(await approveRequest(ctx, root, id, OPTS, META)).toEqual({ ok: false, error: 'Someone already decided this request.' });
    expect(ctx.core.audit.filter((a) => a.op === 'cell.add')).toHaveLength(1);
  });

  it('a double click at the same moment makes one cell', async () => {
    const both = await Promise.all([approveRequest(ctx, root, id, OPTS, META), approveRequest(ctx, root, id, OPTS, META)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(ctx.core.audit.filter((a) => a.op === 'cell.add')).toHaveLength(1);
    expect(ctx.db.select().from(nodes).all()).toHaveLength(1);
  });

  it('a core that refuses restores the request, and creates nothing', async () => {
    ctx.core.simDown('refuse');
    const r = await approveRequest(ctx, root, id, OPTS, META);
    expect(r).toEqual({ ok: false, error: "Core 1 didn't answer; nothing was created." });
    expect(ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, id)).get()?.status).toBe('pending');
    expect(ctx.db.select().from(nodes).all()).toEqual([]);
    expect(rolesOf(ctx, alice)).not.toContain('operator');
  });

  it('a core that hangs restores it too, and restores a question as a question', async () => {
    ctx.db.update(nodeRequests).set({ status: 'question' }).where(eq(nodeRequests.id, id)).run();
    ctx.core.simDown('hang');
    const r = await approveRequest(ctx, root, id, OPTS, META, { deadlineMs: 50 });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("didn't answer") });
    expect(ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, id)).get()?.status).toBe('question');
    expect(ctx.db.select().from(nodes).all()).toEqual([]);
  });

  it('a cell the core made after the page gave up is revoked', async () => {
    const add = vi.spyOn(ctx.core, 'cellAdd').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return ctx.core.simAddCell('late', 'part15', 0);
    });
    const r = await approveRequest(ctx, root, id, OPTS, META, { deadlineMs: 10 });
    expect(r.ok).toBe(false);
    add.mockRestore();
    await new Promise((res) => setTimeout(res, 100));
    expect((await ctx.core.cellStatus(0))[0]).toMatchObject({ revoked: true });
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'node.approve_orphan')).all()).toHaveLength(1);
  });

  it('an insert that fails after cell.add revokes the cell, and audits the orphan', async () => {
    // The next cell's id is taken already: the unique index refuses the node.
    ctx.db.insert(nodes).values({ requestId: 0, coreId: 'fake', cellId: 1, cellName: 'x', certCn: 'x', siteName: 'x', lat: 0, lon: 0, region: 'MD', contactPhone: 'x', anchor: 9, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1 }).run();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await approveRequest(ctx, root, id, OPTS, META);
    log.mockRestore();
    expect(r.ok).toBe(false);
    await vi.waitFor(() => expect(ctx.db.select().from(audit).where(eq(audit.action, 'node.approve_orphan')).all()).toHaveLength(1));
    expect((await ctx.core.cellStatus(0))[0]).toMatchObject({ cellId: 1, revoked: true });
    expect(ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, id)).get()?.status).toBe('pending');
    expect(rolesOf(ctx, alice)).not.toContain('operator');
  });

  it.each([
    [{ coreId: 'fake', anchor: 52, boardRole: 'bs' }],
    [{ coreId: 'fake', anchor: -1, boardRole: 'bs' }],
    [{ coreId: 'fake', anchor: 1, boardRole: 'radio' }],
    [{ coreId: 'nope', anchor: 1, boardRole: 'bs' }],
    [{ anchor: 1, boardRole: 'bs' }],
  ])('refuses options like %j, creating nothing', async (opts) => {
    expect((await approveRequest(ctx, root, id, opts, META)).ok).toBe(false);
    expect(ctx.core.audit.filter((a) => a.op === 'cell.add')).toEqual([]);
    expect(ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, id)).get()?.status).toBe('pending');
  });

  it('is refused on the NOC site', async () => {
    const noc = testCtx({ OC_SITE: 'noc' });
    expect((await approveRequest(noc, 1, 1, OPTS, META)).ok).toBe(false);
  });
});

describe('the cell’s name', () => {
  it('holds nothing of the site name, which subscribers on the cell would see', async () => {
    expect((await approveRequest(ctx, root, id, OPTS, META)).ok).toBe(true);
    const [c] = await ctx.core.cellStatus(0);
    expect(c.name.toLowerCase()).not.toContain('frederick');
    expect(ctx.db.select().from(nodes).get()?.certCn.toLowerCase()).not.toContain('frederick');
  });
});

describe('an approval whose setup token fails', () => {
  it('is still an approval: audited and mailed, with no "try again"', async () => {
    setRelease(ctx);
    // No such table any more: the insert of the token fails, after the node is stored.
    ctx.db.$client.exec('DROP TABLE setup_tokens');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await approveRequest(ctx, root, id, OPTS, META);
    log.mockRestore();
    expect(r).toMatchObject({ ok: true, tokenMade: false });
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'node.approve')).all()).toHaveLength(1);
    const [mail] = await mailsTo('alice@example.org');
    expect(mail.subject).toContain('approved');
  });
});

describe('declining', () => {
  it('closes it, and mails the note', async () => {
    const r = declineRequest(ctx, root, id, 'Too close to another node.', META);
    expect(r.ok).toBe(true);
    expect(ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, id)).get()).toMatchObject({ status: 'declined', declineNote: 'Too close to another node.', decidedBy: root });
    const [mail] = await mailsTo('alice@example.org');
    expect(mail.text).toContain('Too close to another node.');
  });

  it.each(['', 'x'.repeat(1001), 'bad\u0007'])('wants a note: refuses %j', (note) => {
    expect(declineRequest(ctx, root, id, note, META).ok).toBe(false);
  });

  it('refuses one already decided', () => {
    expect(declineRequest(ctx, root, id, 'No.', META).ok).toBe(true);
    expect(declineRequest(ctx, root, id, 'No.', META)).toEqual({ ok: false, error: 'Someone already decided this request.' });
  });
});

describe('the actions', () => {
  it('are a 404 for a non-admin', async () => {
    state.admin = false;
    await expect(approveAction(id, OPTS)).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(declineAction(null, new FormData())).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(askAction(null, new FormData())).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('approving needs a fresh passkey', async () => {
    state.fresh = false;
    expect(await approveAction(id, OPTS)).toEqual({ ok: false, reauth: true });
    expect(ctx.core.audit.filter((a) => a.op === 'cell.add')).toEqual([]);
    state.fresh = true;
    expect(await approveAction(id, OPTS)).toMatchObject({ ok: true });
  });

  it('asks and declines through forms', async () => {
    const form = new FormData();
    form.set('id', String(id));
    form.set('body', 'How high?');
    expect(await askAction(null, form)).toMatchObject({ ok: true });
    expect(ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, id)).get()?.status).toBe('question');
    form.set('body', 'No, thank you.');
    expect(await declineAction(null, form)).toMatchObject({ ok: true });
    expect(ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, id)).get()?.status).toBe('declined');
  });
});

describe('setup tokens', () => {
  const addNode = () =>
    ctx.db.insert(nodes).values({ requestId: 0, userId: alice, coreId: 'fake', cellId: 77, cellName: 'x', certCn: 'cell77-x', siteName: 'x', lat: 0, lon: 0, region: 'MD', contactPhone: 'x', anchor: 9, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1 }).returning().get().id;

  it('are 43 url-safe characters, stored hashed, valid 24 h', () => {
    const n = addNode();
    const t = makeSetupToken(ctx, n, root);
    expect(t.token).toMatch(TOKEN_RE);
    expect(t.expiresAt).toBe(ctx.clock.t + SETUP_TOKEN_MS);
    expect(SETUP_TOKEN_MS).toBe(24 * 3600_000);
    expect(ctx.db.select().from(setupTokens).get()?.id).not.toBe(t.token);
    expect(setupCommand(ctx, t.token)).toBe(`curl -fsSL https://portal.test/setup/${t.token} | sudo bash`);
    expect(peekToken(ctx, t.token)).toMatchObject({ ok: true });
    ctx.clock.t += SETUP_TOKEN_MS;
    expect(peekToken(ctx, t.token)).toEqual({ ok: false, why: 'expired' });
    expect(claimToken(ctx, t.token)).toEqual({ ok: false, why: 'expired' });
  });

  it('a claim is single use; a release gives it back; the sixth claim is one too many', () => {
    const n = addNode();
    const { token } = makeSetupToken(ctx, n, root);
    const first = claimToken(ctx, token);
    expect(first).toMatchObject({ ok: true, node: { id: n } });
    expect(claimToken(ctx, token)).toEqual({ ok: false, why: 'used' });
    if (!first.ok) throw new Error();
    releaseClaim(ctx, first.tokenId);
    for (let i = 0; i < 4; i++) {
      const c = claimToken(ctx, token);
      if (!c.ok) throw new Error(c.why);
      releaseClaim(ctx, c.tokenId);
    }
    expect(claimToken(ctx, token)).toEqual({ ok: false, why: 'tries' });
  });

  it('peeking uses nothing', () => {
    const { token } = makeSetupToken(ctx, addNode(), root);
    for (let i = 0; i < 10; i++) expect(peekToken(ctx, token).ok).toBe(true);
    expect(claimToken(ctx, token).ok).toBe(true);
    expect(peekToken(ctx, token)).toEqual({ ok: false, why: 'used' });
  });

  it('a new token voids the unused one, and a claim running on it cannot come back', () => {
    const n = addNode();
    const a = makeSetupToken(ctx, n, root);
    const claimed = claimToken(ctx, a.token);
    if (!claimed.ok) throw new Error();
    const b = makeSetupToken(ctx, n, root);
    releaseClaim(ctx, claimed.tokenId);
    expect(claimToken(ctx, a.token).ok).toBe(false);
    const c = makeSetupToken(ctx, n, root);
    expect(claimToken(ctx, b.token).ok).toBe(false);
    expect(claimToken(ctx, c.token).ok).toBe(true);
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'setup.void')).all().length).toBeGreaterThan(0);
  });

  it('knows an unknown token, a bad one and a revoked node', () => {
    expect(claimToken(ctx, 'x'.repeat(43))).toEqual({ ok: false, why: 'unknown' });
    expect(claimToken(ctx, 'short')).toEqual({ ok: false, why: 'unknown' });
    expect(peekToken(ctx, '../etc/passwd')).toEqual({ ok: false, why: 'unknown' });
    const n = addNode();
    const { token } = makeSetupToken(ctx, n, root);
    ctx.db.update(nodes).set({ revokedAt: 5 }).where(and(eq(nodes.id, n))).run();
    expect(claimToken(ctx, token)).toEqual({ ok: false, why: 'revoked' });
    expect(peekToken(ctx, token)).toEqual({ ok: false, why: 'revoked' });
  });

});
