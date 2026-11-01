import { eq } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoverageMap } from '@/components/coverage-map';
import { nodeDowntime, nodeRequests, nodes, nodeState, numbers, userRoles, users } from '@/db/schema';
import { publicNodes } from '@/lib/coverage';
import { addDowntime, cancelDowntime, getMyNode, myNodes, newSetupCommand, setAlertsMuted } from '@/lib/nodes/my-nodes';
import { getMyRequest, listMyRequests, postMessage, submitRequest, withdrawRequest } from '@/lib/nodes/requests';
import { askRetire } from '@/lib/nodes/my-nodes';
import { sessionFromToken, createSession } from '@/lib/sessions';
import { testCtx, type TestCtx } from '../helpers/ctx';

// Portal spec §13: subscriber A's nodes and requests are not B's business;
// a non-admin gets a 404 on every admin action; a stale admin session must
// confirm with a passkey; a contact phone and an exact pin reach no one else.

const META = { ip: '203.0.113.9' };
const PHONE = '+1 (301) 555-0199';
const LAT = '39.414371';
const LON = '-77.410541';
const GOOD = { siteName: 'Secret Street 12', lat: LAT, lon: LON, region: 'MD', piModel: 'pi5', w12Boards: '1', gps: true, antenna: 'Vertical', backhaul: 'home', power: 'mains', contactPhone: PHONE, agree: true, agreementVersion: 1 };
const N1 = '+883171746412345';

const state: { ctx?: TestCtx; token?: string } = {};
vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === state.ctx!.config.sessionCookie && state.token ? { value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-oc-client-ip': META.ip }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const { approveAction, askAction, declineAction } = await import('@/app/actions/admin-nodes');
const { disableAccountAction, enableAccountAction, numberDisabledAction } = await import('@/app/actions/admin-subscribers');
const { revokeCellAction } = await import('@/app/actions/admin-cells');
const { npaOverrideAction } = await import('@/app/actions/admin-blocks');
const nodesActions = await import('@/app/actions/nodes');

let ctx: TestCtx;
let alice: number;
let bob: number;
let root: number;
let requestId: number;
let nodeId: number;
let cellId: number;

const user = (name: string, email: string) => ctx.db.insert(users).values({ name, email, emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;

beforeEach(() => {
  ctx = testCtx();
  state.ctx = ctx;
  state.token = undefined;
  root = user('Root', 'root@example.org');
  ctx.db.insert(userRoles).values({ userId: root, role: 'admin', grantedAt: 1 }).run();
  alice = user('Alice', 'alice@example.org');
  bob = user('Bob', 'bob@example.org');
  const r = submitRequest(ctx, alice, GOOD, META);
  if (!r.ok) throw new Error(r.error);
  requestId = r.id;
  cellId = ctx.core.simAddCell('secret-street', 'part15', 0, 'a'.repeat(64));
  nodeId = ctx.db.insert(nodes).values({ requestId, userId: alice, coreId: 'fake', cellId, cellName: 'secret-street', certCn: 'x', siteName: 'Secret Street 12', lat: Number(LAT), lon: Number(LON), region: 'MD', contactPhone: PHONE, anchor: 3, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1, certFpr: 'a'.repeat(64) }).returning().get().id;
  ctx.db.insert(nodeState).values({ nodeId, online: true, checkedAt: 1 }).run();
  ctx.core.simSubscriber(N1, 1, null);
  ctx.db.insert(numbers).values({ number: N1, userId: alice, coreId: 'fake', createdAt: 1, state: 'activated' }).run();
});

afterEach(() => vi.restoreAllMocks());

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('subscriber B against A’s requests and nodes', () => {
  it('cannot read A’s request', () => {
    expect(getMyRequest(ctx, bob, requestId)).toBeNull();
    expect(listMyRequests(ctx, bob)).toEqual([]);
  });

  it('cannot reply in A’s thread', () => {
    expect(postMessage(ctx, { requestId, authorId: bob, fromAdmin: false, body: 'Hello' }, META).ok).toBe(false);
    expect(getMyRequest(ctx, alice, requestId)!.thread).toEqual([]);
  });

  it('cannot withdraw it', () => {
    expect(withdrawRequest(ctx, bob, requestId, META).ok).toBe(false);
    expect(ctx.db.select().from(nodeRequests).where(eq(nodeRequests.id, requestId)).get()?.status).toBe('pending');
  });

  it('cannot read A’s node', async () => {
    expect(await getMyNode(ctx, bob, nodeId)).toBeNull();
    expect(await myNodes(ctx, bob)).toEqual([]);
  });

  it('cannot mute it', () => {
    expect(setAlertsMuted(ctx, bob, nodeId, true, META).ok).toBe(false);
    expect(ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()?.alertsMuted).toBe(false);
  });

  it('cannot add or cancel its downtime', () => {
    const w = { startsAt: ctx.now() + 60_000, endsAt: ctx.now() + 120_000, reason: 'Not mine' };
    expect(addDowntime(ctx, bob, nodeId, w, META).ok).toBe(false);
    expect(addDowntime(ctx, alice, nodeId, w, META).ok).toBe(true);
    const row = ctx.db.select().from(nodeDowntime).get()!;
    expect(cancelDowntime(ctx, bob, row.id, META).ok).toBe(false);
    expect(ctx.db.select().from(nodeDowntime).get()?.cancelledAt).toBeNull();
  });

  it('cannot make a setup command for it', () => {
    expect(newSetupCommand(ctx, bob, nodeId, META)).toEqual({ ok: false, error: 'You have no such node.' });
  });

  it('cannot retire it', () => {
    expect(askRetire(ctx, bob, nodeId, 'Bye', META).ok).toBe(false);
  });

  it('the node actions take the account from the session, not from the request', async () => {
    state.token = createSession(ctx, bob, 'email', META).token;
    const id = String(nodeId);
    expect(await nodesActions.setAlertsAction(null, form({ id, muted: '1' }))).toMatchObject({ ok: false });
    expect(await nodesActions.addDowntimeAction(null, form({ id, startsAt: String(ctx.now() + 1000), endsAt: String(ctx.now() + 2000), reason: 'Not mine' }))).toMatchObject({ ok: false });
    expect(await nodesActions.newSetupCommandAction(null, form({ id }))).toMatchObject({ ok: false });
    expect(await nodesActions.retireAction(null, form({ id, body: 'Bye' }))).toMatchObject({ ok: false });
    expect(await nodesActions.simulateNodeAction(null, form({ id, online: '1' }))).toMatchObject({ ok: false });
    expect(await nodesActions.withdrawRequestAction(null, form({ id: String(requestId) }))).toMatchObject({ ok: false });
    expect(await nodesActions.replyAction(null, form({ id: String(requestId), body: 'Hello' }))).toMatchObject({ ok: false });
  });

  it('signed out, every node action goes to sign-in', async () => {
    const id = String(nodeId);
    for (const run of [
      () => nodesActions.acceptAgreementAction(form({})),
      () => nodesActions.submitRequestAction(null, form({})),
      () => nodesActions.withdrawRequestAction(null, form({ id })),
      () => nodesActions.replyAction(null, form({ id })),
      () => nodesActions.newSetupCommandAction(null, form({ id })),
      () => nodesActions.setAlertsAction(null, form({ id })),
      () => nodesActions.addDowntimeAction(null, form({ id })),
      () => nodesActions.cancelDowntimeAction(null, form({ id })),
      () => nodesActions.retireAction(null, form({ id })),
      () => nodesActions.simulateNodeAction(null, form({ id })),
    ]) {
      await expect(run()).rejects.toThrow('NEXT_REDIRECT /sign-in');
    }
  });
});

const adminCalls: [string, () => Promise<unknown>][] = [
  ['approve', () => approveAction(1, { coreId: 'fake', anchor: 1, boardRole: 'bs' })],
  ['decline', () => declineAction(null, form({ id: '1', body: 'No' }))],
  ['ask', () => askAction(null, form({ id: '1', body: 'Why?' }))],
  ['disable an account', () => disableAccountAction(1, 'a@example.org')],
  ['enable an account', () => enableAccountAction(1)],
  ['disable a number', () => numberDisabledAction(N1, true)],
  ['revoke a cell', () => revokeCellAction('fake', 1, 'x')],
  ['move an NPA', () => npaOverrideAction('717', 2)],
];

describe('the admin actions', () => {
  it.each(adminCalls)('a subscriber gets a 404: %s', async (_w, run) => {
    state.token = createSession(ctx, bob, 'passkey', META, { uv: true, credentialId: 'c' }).token;
    await expect(run()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(ctx.core.audit.filter((a) => a.op !== 'cell.status')).toEqual([]);
  });

  it.each(adminCalls)('signed out gets a 404: %s', async (_w, run) => {
    await expect(run()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it.each(adminCalls)('an email-link session of an admin goes to a passkey sign-in: %s', async (_w, run) => {
    state.token = createSession(ctx, root, 'email', META).token;
    await expect(run()).rejects.toThrow('NEXT_REDIRECT /sign-in?admin=1');
  });

  const stale = adminCalls.filter(([w]) => w !== 'decline' && w !== 'ask');

  it.each(stale)('an admin whose passkey is not fresh is asked again: %s', async (_w, run) => {
    state.token = createSession(ctx, root, 'passkey', META, { uv: true, credentialId: 'c' }).token;
    expect(sessionFromToken(ctx, state.token)?.session.reauthAt).toBeNull();
    expect(await run()).toEqual({ ok: false, reauth: true });
    expect(ctx.core.audit.filter((a) => a.op !== 'cell.status')).toEqual([]);
  });
});

describe('what reaches someone who isn’t the operator', () => {
  const secrets = ['555-0199', LAT, LON, 'Secret Street', 'secret-street', 'alice@', 'Alice'];

  it('never the phone, the pin, the site name or the operator on the public map', () => {
    const rows = publicNodes(ctx);
    expect(rows).toHaveLength(1);
    const html = renderToStaticMarkup(CoverageMap({ nodes: rows }));
    for (const s of secrets) {
      expect(JSON.stringify(rows)).not.toContain(s);
      expect(html).not.toContain(s);
    }
  });

  it('nothing at all for B', async () => {
    const out = JSON.stringify([await myNodes(ctx, bob), listMyRequests(ctx, bob), getMyRequest(ctx, bob, requestId), await getMyNode(ctx, bob, nodeId)]);
    for (const s of secrets) expect(out).not.toContain(s);
  });

  it('the operator’s card holds no contact phone (it is for admins)', async () => {
    const out = JSON.stringify(await myNodes(ctx, alice));
    expect(out).not.toContain('555-0199');
  });

  it('a question mail holds neither', async () => {
    postMessage(ctx, { requestId, authorId: root, fromAdmin: true, body: 'How high?' }, META);
    await ctx.mailQueue.drain();
    for (const m of ctx.mailer.sent) {
      expect(m.text).not.toContain('555-0199');
      expect(m.text).not.toContain(LAT);
    }
  });
});
