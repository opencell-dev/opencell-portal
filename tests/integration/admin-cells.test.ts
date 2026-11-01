import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, nodeDowntime, nodes, nodeState, setupTokens, userRoles, users } from '@/db/schema';
import { allCells, revokeCell } from '@/lib/admin/cells';
import { publicNodes } from '@/lib/coverage';
import { auditPage } from '@/lib/audit';
import { makeSetupToken, peekToken } from '@/lib/nodes/setup-tokens';
import { testCtx, type TestCtx } from '../helpers/ctx';

const META = { ip: '203.0.113.9' };
const state: { ctx?: TestCtx; admin: boolean; fresh: boolean; adminId: number } = { admin: true, fresh: true, adminId: 0 };
vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/server/request', () => ({
  freshAdmin: async () => {
    if (!state.admin) throw new Error('NEXT_NOT_FOUND');
    return state.fresh ? { ok: true, s: { user: { id: state.adminId } } } : { ok: false, reauth: true };
  },
  requestMeta: async () => META,
}));
const { revokeCellAction } = await import('@/app/actions/admin-cells');

let ctx: TestCtx;
let root: number;
let alice: number;
let cellId: number;
let nodeId: number;

beforeEach(() => {
  ctx = testCtx();
  state.ctx = ctx;
  state.admin = true;
  state.fresh = true;
  root = ctx.db.insert(users).values({ name: 'Root', email: 'root@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  state.adminId = root;
  ctx.db.insert(userRoles).values({ userId: root, role: 'admin', grantedAt: 1 }).run();
  alice = ctx.db.insert(users).values({ name: 'Alice', email: 'alice@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  cellId = ctx.core.simAddCell('roof', 'part15', 0, 'a'.repeat(64));
  const n = ctx.db.insert(nodes).values({ requestId: 1, userId: alice, coreId: 'fake', cellId, cellName: 'roof', certCn: 'x', siteName: 'Alice Roof', lat: 39.4, lon: -77.4, region: 'MD', contactPhone: '+13015550100', anchor: 3, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1, certFpr: 'a'.repeat(64) }).returning().get();
  nodeId = n.id;
  ctx.db.insert(nodeState).values({ nodeId, online: true, checkedAt: 1 }).run();
});

describe('allCells', () => {
  it('merges the core’s cells with the portal’s nodes, and marks one from outside', async () => {
    const outside = ctx.core.simAddCell('cell-t', 'part15', 0);
    const [c] = await allCells(ctx, root);
    expect(c).toMatchObject({ coreId: 'fake', reachable: true });
    const mine = c.rows.find((r) => r.cellId === cellId)!;
    expect(mine).toMatchObject({ name: 'roof', outside: false, node: { id: nodeId, siteName: 'Alice Roof', operator: 'Alice (alice@example.org)', contactPhone: '+13015550100' } });
    expect(mine.node?.downtime).toEqual([]);
    expect(c.rows.find((r) => r.cellId === outside)).toMatchObject({ outside: true, node: null });
    expect(ctx.core.audit.at(-1)).toMatchObject({ actor: root, op: 'cell.status' });
  });

  it('shows downtime notices to admins', async () => {
    ctx.db.insert(nodeDowntime).values({ nodeId, startsAt: ctx.now(), endsAt: ctx.now() + 1000, reason: 'Roof work', createdBy: alice, createdAt: ctx.now() }).run();
    const [c] = await allCells(ctx, root);
    expect(c.rows[0].node?.downtime).toEqual([expect.objectContaining({ reason: 'Roof work' })]);
  });

  it('a node with no operator says so', async () => {
    ctx.db.update(nodes).set({ userId: null }).where(eq(nodes.id, nodeId)).run();
    expect((await allCells(ctx, root))[0].rows[0].node?.operator).toBeNull();
  });

  it('a core that does not answer is marked, not fatal', async () => {
    ctx.core.simDown('refuse');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [c] = await allCells(ctx, root);
    log.mockRestore();
    expect(c).toEqual({ coreId: 'fake', reachable: false, rows: [] });
  });
});

describe('revoking a cell', () => {
  it('revokes and unpins at the core, closes the node and its tokens, and tells the operator', async () => {
    const { token } = makeSetupToken(ctx, nodeId, null);
    expect(publicNodes(ctx)).toHaveLength(1);
    const r = await revokeCell(ctx, root, 'fake', cellId, META);
    expect(r).toEqual({ ok: true });
    expect((await ctx.core.cellStatus(0, cellId))[0]).toMatchObject({ revoked: true, certFpr: null, online: false });
    expect(ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()?.revokedAt).toBe(ctx.clock.t);
    expect(peekToken(ctx, token)).toEqual({ ok: false, why: 'revoked' });
    expect(ctx.db.select().from(setupTokens).get()?.usedAt).not.toBeNull();
    expect(publicNodes(ctx)).toEqual([]);
    await ctx.mailQueue.drain();
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ to: 'alice@example.org', subject: expect.stringContaining('revoked') });
    expect(ctx.db.select().from(audit).where(eq(audit.action, 'cell.revoke')).all()).toEqual([expect.objectContaining({ actorId: root, target: 'fake/' + cellId })]);
    expect(ctx.core.audit.filter((a) => a.op === 'cell.revoke')).toEqual([expect.objectContaining({ actor: root })]);
  });

  it('works on a cell added outside the portal', async () => {
    const outside = ctx.core.simAddCell('cell-t', 'part15', 0);
    expect((await revokeCell(ctx, root, 'fake', outside, META)).ok).toBe(true);
    expect((await ctx.core.cellStatus(0, outside))[0].revoked).toBe(true);
  });

  it('a core that does not answer changes nothing here', async () => {
    ctx.core.simDown('refuse');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await revokeCell(ctx, root, 'fake', cellId, META);
    log.mockRestore();
    expect(r.ok).toBe(false);
    expect(ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()?.revokedAt).toBeNull();
  });

  it('knows no other core, or no such cell', async () => {
    expect((await revokeCell(ctx, root, 'nope', cellId, META)).ok).toBe(false);
    expect((await revokeCell(ctx, root, 'fake', 999, META)).ok).toBe(false);
  });

  it('the action needs a fresh passkey, the cell’s name typed, and an admin', async () => {
    state.fresh = false;
    expect(await revokeCellAction('fake', cellId, 'roof')).toEqual({ ok: false, reauth: true });
    expect((await ctx.core.cellStatus(0, cellId))[0].revoked).toBe(false);
    state.fresh = true;
    expect(await revokeCellAction('fake', cellId, 'wrong')).toMatchObject({ ok: false, message: expect.stringContaining('name') });
    expect((await ctx.core.cellStatus(0, cellId))[0].revoked).toBe(false);
    expect(await revokeCellAction('fake', cellId, 'roof')).toMatchObject({ ok: true });
    expect((await ctx.core.cellStatus(0, cellId))[0].revoked).toBe(true);
    state.admin = false;
    await expect(revokeCellAction('fake', cellId, 'roof')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('the action refuses on the NOC site', async () => {
    state.ctx = testCtx({ OC_SITE: 'noc' });
    expect(await revokeCellAction('fake', 1, 'roof')).toMatchObject({ ok: false });
  });
});

describe('auditPage', () => {
  const seed = () => {
    ctx.db.delete(audit).run();
    for (let i = 0; i < 5; i++) ctx.db.insert(audit).values({ at: 1000 + i, actorId: i % 2 ? 7 : 8, action: i % 2 ? 'a.one' : 'b.two', target: `t:${i}` }).run();
  };

  it('filters by action, actor and target', () => {
    seed();
    expect(auditPage(ctx, { action: 'a.one' }).rows.map((r) => r.target)).toEqual(['t:3', 't:1']);
    expect(auditPage(ctx, { actor: 8 }).rows.map((r) => r.target)).toEqual(['t:4', 't:2', 't:0']);
    expect(auditPage(ctx, { target: 't:2' }).rows).toHaveLength(1);
    expect(auditPage(ctx, { action: 'a.one', actor: 8 }).rows).toEqual([]);
  });

  it('pages, newest first', () => {
    seed();
    const a = auditPage(ctx, {}, 2);
    expect(a.rows.map((r) => r.target)).toEqual(['t:4', 't:3']);
    expect(a.next).toBe(a.rows[1].id);
    const b = auditPage(ctx, { before: a.next! }, 2);
    expect(b.rows.map((r) => r.target)).toEqual(['t:2', 't:1']);
    const c = auditPage(ctx, { before: b.next! }, 2);
    expect(c.rows.map((r) => r.target)).toEqual(['t:0']);
    expect(c.next).toBeNull();
  });
});
