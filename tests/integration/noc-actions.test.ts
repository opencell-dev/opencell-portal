import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@/config';
import { FakeCore } from '@/core/fake';
import { CoreError } from '@/core/types';
import { listAudit } from '@/lib/audit';
import { LOOKUP_CDRS, normalizeNumber } from '@/lib/noc/lookup';
import { cachedSnapshot } from '@/lib/noc/snapshot';
import { setLimit } from '@/lib/ratelimit';
import { type TestCtx, testCtx } from '../helpers/ctx';

// NOC design §9.5, §10, §11: the number lookup (open to staff: admins and
// NOC operators, ruling 2026-10-01 #8/#9) and the demo controls (admin
// only). The guard is mocked here (route-guards.test.ts checks it is the
// first statement); what is tested is what the actions do once it passed.

const state: { ctx?: TestCtx; admin: boolean; noc: boolean } = { admin: true, noc: true };

vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('@/server/request', () => ({
  requireAdmin: async () => {
    if (!state.admin) throw new Error('NEXT_NOT_FOUND');
    return { user: { id: 42 } };
  },
  requireNoc: async () => {
    if (!state.admin && !state.noc) throw new Error('NEXT_NOT_FOUND');
    return { user: { id: 42 } };
  },
  requestMeta: async () => ({ ip: '192.0.2.7' }),
}));

const { demoAction, lookupNumberAction } = await import('@/app/actions/admin-noc');

const N = '+883171746412345';
let ctx: TestCtx;

beforeEach(() => {
  ctx = testCtx();
  state.ctx = ctx;
  state.admin = true;
  state.noc = true;
});

describe('number lookup', () => {
  it('takes a number as people type it', () => {
    expect(normalizeNumber(' +883-1-717-464-12345 ')).toBe(N);
    expect(normalizeNumber('883 1 717 464 12345')).toBe(N);
    expect(normalizeNumber('(883) 1.717.464.12345')).toBe(N);
    expect(normalizeNumber('+1 717 464 1234')).toBeNull();
    expect(normalizeNumber('')).toBeNull();
  });

  it("shows a number's status and its calls, newest first, as the admin, and audits the lookup", async () => {
    ctx.core.simSubscriber(N, 0x76ad0488, null);
    ctx.core.simCall({ at: ctx.now() - 3600_000, number: N, peer: '+883160655500100', direction: 'out', durationS: 30, result: 'answered' });
    ctx.core.simCall({ at: ctx.now() - 60_000, number: N, peer: '+883171746454321', direction: 'in', durationS: 0, result: 'no_answer' });
    ctx.core.simCall({ at: ctx.now() - 40 * 86400_000, number: N, peer: '+883171746454321', direction: 'in', durationS: 5, result: 'answered' });
    const r = await lookupNumberAction('+883-1-717-464-12345');
    expect(r).toMatchObject({ ok: true, number: N, core: 'fake', status: { state: 'activated', tmidPrefix: '76ad' }, more: false });
    if (!r.ok) throw new Error(r.message);
    expect(r.cdrs.map((c) => c.result)).toEqual(['no_answer', 'answered']);
    expect(ctx.core.audit.filter((a) => a.op === 'sub.status' || a.op === 'cdr.list').map((a) => [a.actor, a.op])).toEqual([
      [42, 'sub.status'],
      [42, 'cdr.list'],
    ]);
    expect(listAudit(ctx, 1)[0]).toMatchObject({
      actorId: 42,
      action: 'noc.lookup',
      target: `number:${N}`,
      detail: '{"core":"fake","found":true}',
      ip: '192.0.2.7',
    });
  });

  it('shows at most the newest LOOKUP_CDRS calls and says there are more', async () => {
    ctx.core.simSubscriber(N, 1, null);
    for (let i = 0; i < LOOKUP_CDRS + 5; i++) {
      ctx.core.simCall({ at: ctx.now() - i * 1000, number: N, peer: '+883171746454321', direction: 'out', durationS: 1, result: 'answered' });
    }
    const r = await lookupNumberAction(N);
    expect(r.ok && r.cdrs.length).toBe(LOOKUP_CDRS);
    expect(r.ok && r.more).toBe(true);
  });

  it('says so for a number nobody has, and still audits the lookup', async () => {
    expect(await lookupNumberAction(N)).toEqual({ ok: false, message: `No subscriber has ${N} on fake.` });
    expect(listAudit(ctx, 1)[0]).toMatchObject({ action: 'noc.lookup', detail: '{"core":"fake","found":false}' });
  });

  it('refuses what is not a full number, without asking the core', async () => {
    const before = ctx.core.audit.length;
    expect(await lookupNumberAction('12345')).toMatchObject({ ok: false, message: expect.stringContaining('not a full OpenCell number') });
    expect(await lookupNumberAction(`+${'8'.repeat(60)}`)).toMatchObject({ ok: false });
    expect(await lookupNumberAction(7 as unknown as string)).toMatchObject({ ok: false });
    expect(ctx.core.audit.length).toBe(before);
  });

  it('gives a plain message when the core fails or limits, never the error itself, and never logs the number (review M2)', async () => {
    vi.spyOn(ctx.core, 'subStatus').mockRejectedValueOnce(new CoreError('unavailable', 'connect ECONNREFUSED 10.0.0.60:7444'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await lookupNumberAction(N)).toEqual({ ok: false, message: 'fake did not answer; try again.' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fake failed: CoreError unavailable'));
    expect(log.mock.calls.flat().some((a) => String(a).includes(N))).toBe(false);
    vi.spyOn(ctx.core, 'subStatus').mockRejectedValueOnce(new CoreError('rate_limited'));
    expect(await lookupNumberAction(N)).toEqual({ ok: false, message: 'fake is limiting these requests; try again in a minute.' });
    log.mockRestore();
  });

  it('is rate-limited per admin (noc_lookup), and audits a limited refusal (review M3)', async () => {
    setLimit(ctx, 'noc_lookup', 2);
    await lookupNumberAction(N);
    await lookupNumberAction(N);
    expect(await lookupNumberAction(N)).toEqual({ ok: false, message: 'Too many number lookups this hour. Please try again later.' });
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: 42, action: 'noc.lookup.limited', target: `number:${N}` });
  });

  it('lets a NOC operator look up a number too (ruling 2026-10-01 #8/#9), but not the demo controls', async () => {
    state.admin = false;
    state.noc = true;
    ctx.core.simSubscriber(N, 1, null);
    const r = await lookupNumberAction(N);
    expect(r).toMatchObject({ ok: true, number: N });
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: 42, action: 'noc.lookup' });
    await expect(demoAction({ op: 'load' })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('the demo controls', () => {
  it('load the demo network on every fake core, and make the next snapshot ask again', async () => {
    const before = await cachedSnapshot(ctx);
    expect(before.cores[0].cells).toEqual([]);
    expect(await demoAction({ op: 'load' })).toEqual({ ok: true, message: 'The demo network is loaded on fake.' });
    const after = await cachedSnapshot(ctx);
    expect(after.cores[0].cells?.length).toBeGreaterThan(0);
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: 42, action: 'demo.load' });
  });

  it('make a fake core refuse, and answer again', async () => {
    expect(await demoAction({ op: 'down', core: 'fake', mode: 'refuse' })).toEqual({ ok: true, message: 'fake now refuses every call.' });
    expect(ctx.core.isDown).toBe('refuse');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await cachedSnapshot(ctx)).cores[0].status).toBeNull();
    expect(await demoAction({ op: 'down', core: 'fake', mode: 'none' })).toEqual({ ok: true, message: 'fake answers again.' });
    expect((await cachedSnapshot(ctx)).cores[0].status).not.toBeNull();
  });

  it('take a cell offline and back', async () => {
    const id = ctx.core.simAddCell('A', 'part15', 1);
    expect(await demoAction({ op: 'cell', core: 'fake', cellId: id, online: true })).toEqual({ ok: true, message: `Cell ${id} on fake is online.` });
    expect(ctx.core.simCells()[0].online).toBe(true);
    expect(await demoAction({ op: 'cell', core: 'fake', cellId: 99, online: true })).toEqual({ ok: false, message: 'No cell 99 on fake.' });
  });

  it('refuse anything else, an unknown core, and every control without the fake core', async () => {
    expect(await demoAction({ op: 'drop-tables' })).toEqual({ ok: false, message: 'Not a demo control.' });
    expect(await demoAction({ op: 'down', core: 'core9', mode: 'hang' })).toEqual({ ok: false, message: 'No fake core core9.' });
    state.ctx = {
      ...ctx,
      config: parseConfig({
        OC_ORIGIN: 'https://portal.test',
        OC_RP_ID: 'portal.test',
        OC_SECRET: 'x'.repeat(64),
        OC_CORE: 'tls',
        OC_CORE_ADDR: '10.0.0.60:7444',
        OC_CORE_CA: 'ca',
        OC_CORE_CERT: 'c',
        OC_CORE_KEY: 'k',
      }),
    };
    expect(await demoAction({ op: 'load' })).toEqual({ ok: false, message: 'The demo controls work only with the fake core.' });
    expect(ctx.core).toBeInstanceOf(FakeCore);
  });

  it('are refused to anyone the guard refuses', async () => {
    state.admin = false;
    state.noc = false;
    await expect(demoAction({ op: 'load' })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(lookupNumberAction(N)).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
