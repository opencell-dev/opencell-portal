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

const state: { ctx?: TestCtx; admin: boolean; noc: boolean; fresh: boolean } = { admin: true, noc: true, fresh: true };

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
  freshNoc: async () => {
    if (!state.admin && !state.noc) throw new Error('NEXT_NOT_FOUND');
    return state.fresh ? { ok: true, s: { user: { id: 42 } } } : { ok: false, reauth: true };
  },
  freshAdmin: async () => {
    if (!state.admin) throw new Error('NEXT_NOT_FOUND');
    return state.fresh ? { ok: true, s: { user: { id: 42 } } } : { ok: false, reauth: true };
  },
  requestMeta: async () => ({ ip: '192.0.2.7' }),
}));

const { cellModeAction, demoAction, lookupNumberAction, registrationsAction, subscriberAction } = await import('@/app/actions/admin-noc');

const N = '+883171746412345';
let ctx: TestCtx;

beforeEach(() => {
  ctx = testCtx({ OC_SITE: 'noc' });
  state.ctx = ctx;
  state.admin = true;
  state.noc = true;
  state.fresh = true;
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
      // On the NOC site, the core is told the account id offset (NOC design §N1.5).
      [1_000_042, 'sub.status'],
      [1_000_042, 'cdr.list'],
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
        OC_SITE: 'noc',
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

  it('are refused on the subscriber portal, even to an admin with the fake core (NOC design §N1.5)', async () => {
    state.ctx = { ...ctx, config: { ...ctx.config, site: 'portal' } };
    expect(await demoAction({ op: 'load' })).toEqual({ ok: false, message: 'The demo controls are on the NOC site only.' });
    expect(ctx.core.simCells()).toEqual([]);
  });

  it('are refused to anyone the guard refuses', async () => {
    state.admin = false;
    state.noc = false;
    await expect(demoAction({ op: 'load' })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(lookupNumberAction(N)).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('registrations, the next page (plan N2a)', () => {
  it('gives the numbers after the last one shown, as the staff member, audited', async () => {
    const id = ctx.core.simAddCell('A', 'part15', 1);
    ctx.core.simSubscriber('+883171746410000', 1, id);
    ctx.core.simSubscriber(N, 2, id);
    state.admin = false; // a NOC operator
    const r = await registrationsAction({ core: 'fake', after: '+883171746410000' });
    expect(r).toMatchObject({ ok: true, more: false, rows: [{ number: N }] });
    expect(ctx.core.audit.at(-1)).toMatchObject({ actor: 1_000_042, op: 'reg.list' });
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: 42, action: 'noc.registrations', ip: '192.0.2.7' });
  });

  it('refuses what is not a page: no cursor, a cursor that is not a number, an unknown core', async () => {
    for (const bad of [{ core: 'fake' }, { core: 'fake', after: '12345' }, { core: 'nope', after: N }, 'x', null]) {
      expect(await registrationsAction(bad)).toEqual({ ok: false, message: 'Not a page of registrations.' });
    }
  });

  it('is for staff only', async () => {
    state.admin = false;
    state.noc = false;
    await expect(registrationsAction({ core: 'fake', after: N })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('disable and enable a subscriber (plan N2a; decision 2026-10-01 #10)', () => {
  it('lets a NOC operator disable a number with a reason, under their account, audited with the reason and outcome', async () => {
    const id = ctx.core.simAddCell('A', 'part15', 1);
    ctx.core.simSubscriber(N, 0x76ad0488, id);
    state.admin = false;
    const r = await subscriberAction({ number: '+883-1-717-464-12345', enable: false, reason: 'stolen handset' });
    expect(r).toEqual({ ok: true, message: "+883-1-717-464-12345 is disabled on fake: it can't register or call until it is enabled." });
    expect(await ctx.core.subStatus(0, N)).toMatchObject({ disabled: true, registered: false });
    expect(ctx.core.audit.at(-2)).toMatchObject({ actor: 1_000_042, op: 'sub.disable', arg: N });
    expect(listAudit(ctx, 1)[0]).toMatchObject({
      actorId: 42,
      action: 'noc.sub.disable',
      target: `number:${N}`,
      detail: JSON.stringify({ core: 'fake', reason: 'stolen handset', outcome: 'ok' }),
      ip: '192.0.2.7',
    });
    expect(await subscriberAction({ number: N, enable: true, reason: 'found again' })).toMatchObject({ ok: true, message: '+883-1-717-464-12345 is enabled again on fake.' });
    expect((await ctx.core.subStatus(0, N)).disabled).toBe(false);
  });

  it('asks for a fresh passkey first, and changes nothing until then', async () => {
    ctx.core.simSubscriber(N, 1, null);
    state.fresh = false;
    expect(await subscriberAction({ number: N, enable: false, reason: 'test' })).toEqual({ ok: false, reauth: true });
    expect((await ctx.core.subStatus(0, N)).disabled).toBe(false);
    expect(listAudit(ctx, 5).filter((a) => a.action.startsWith('noc.sub'))).toEqual([]);
  });

  it('wants a reason and a full number; says when there is no such subscriber, and audits that', async () => {
    expect(await subscriberAction({ number: N, enable: false, reason: ' x ' })).toEqual({ ok: false, message: 'Say why (3–200 characters).' });
    expect(await subscriberAction({ number: '+1717', enable: false, reason: 'test' })).toMatchObject({ ok: false, message: expect.stringContaining('not a full') });
    expect(await subscriberAction({ number: N, enable: false, reason: 'test' })).toEqual({ ok: false, message: 'No subscriber has +883-1-717-464-12345 on fake.' });
    expect(JSON.parse(listAudit(ctx, 1)[0].detail ?? '{}')).toMatchObject({ outcome: 'not_found' });
  });

  it('limits each person to 30 changes an hour', async () => {
    ctx.core.simSubscriber(N, 1, null);
    setLimit(ctx, 'noc_change', 2);
    await subscriberAction({ number: N, enable: false, reason: 'one' });
    await subscriberAction({ number: N, enable: true, reason: 'two' });
    expect(await subscriberAction({ number: N, enable: false, reason: 'three' })).toEqual({ ok: false, message: 'Too many changes this hour. Please try again later.' });
    expect(listAudit(ctx, 1)[0]).toMatchObject({ action: 'noc.sub.disable.limited' });
  });

  it('is for staff only', async () => {
    state.admin = false;
    state.noc = false;
    await expect(subscriberAction({ number: N, enable: false, reason: 'test' })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('the mode switch (plan N2a; NOC design §4.3)', () => {
  function lancaster() {
    const id = ctx.core.simAddCell('Lancaster 1', 'part15', 1);
    ctx.core.simCellOnline(id, true);
    ctx.core.simActiveCalls(id, 2);
    return id;
  }

  it('switches a cell once its name is typed, ending its calls, under the admin account, audited with the impact and reason', async () => {
    const id = lancaster();
    await cachedSnapshot(ctx); // cached as Part 15
    const r = await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'Lancaster 1', reason: 'licensed operator on site' });
    expect(r).toEqual({ ok: true, message: 'Lancaster 1 is switching to Part 97: it reconnects in a few seconds; 2 calls ended.' });
    expect((await ctx.core.cellStatus(0, id))[0]).toMatchObject({ mode: 'part97', calls: 0 });
    // The shared snapshot is asked again, so the page shows the new mode at once.
    expect((await cachedSnapshot(ctx)).cores[0].cells?.find((c) => c.cellId === id)?.mode).toBe('part97');
    expect(ctx.core.audit.filter((a) => a.op === 'cell.mode')).toEqual([expect.objectContaining({ actor: 1_000_042, arg: String(id) })]);
    expect(listAudit(ctx, 1)[0]).toMatchObject({
      actorId: 42,
      action: 'noc.cell.mode',
      target: `cell:fake/${id}`,
      detail: JSON.stringify({ core: 'fake', cell: id, from: 'part15', to: 'part97', callsBefore: 2, reason: 'licensed operator on site', outcome: 'ok' }),
    });
  });

  it('changes nothing for a wrong name, and says so; already in that mode is fine and changes nothing', async () => {
    const id = lancaster();
    expect(await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'lancaster 1', reason: 'test' })).toEqual({
      ok: false,
      message: 'Type the cell\'s name exactly ("Lancaster 1") to confirm; nothing was changed.',
    });
    expect((await ctx.core.cellStatus(0, id))[0]).toMatchObject({ mode: 'part15', calls: 2 });
    expect(await cellModeAction({ core: 'fake', cellId: id, mode: 'part15', confirmName: 'Lancaster 1', reason: 'test' })).toEqual({
      ok: true,
      message: 'Lancaster 1 is already Part 15; nothing was changed.',
    });
    expect(ctx.core.audit.some((a) => a.op === 'cell.mode')).toBe(false);
    expect(JSON.parse(listAudit(ctx, 1)[0].detail ?? '{}')).toMatchObject({ outcome: 'unchanged' });
  });

  it('refuses a revoked cell, an unknown cell or core, and a missing reason', async () => {
    const id = lancaster();
    await ctx.core.cellRevoke(0, id);
    expect(await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'Lancaster 1', reason: 'test' })).toEqual({
      ok: false,
      message: `Cell ${id} is revoked; its mode can't change.`,
    });
    expect(await cellModeAction({ core: 'fake', cellId: 99, mode: 'part97', confirmName: 'x', reason: 'test' })).toEqual({ ok: false, message: 'No cell 99 on fake.' });
    expect(await cellModeAction({ core: 'nope', cellId: id, mode: 'part97', confirmName: 'x', reason: 'test' })).toEqual({ ok: false, message: 'No core nope.' });
    expect(await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'Lancaster 1', reason: '' })).toMatchObject({ ok: false });
  });

  it('is for admins only, with a fresh passkey, and on the NOC site only', async () => {
    const id = lancaster();
    state.fresh = false;
    expect(await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'Lancaster 1', reason: 'test' })).toEqual({ ok: false, reauth: true });
    state.fresh = true;
    state.admin = false; // a NOC operator
    await expect(cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'Lancaster 1', reason: 'test' })).rejects.toThrow('NEXT_NOT_FOUND');
    state.admin = true;
    state.ctx = testCtx(); // the subscriber portal
    expect(await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'Lancaster 1', reason: 'test' })).toEqual({
      ok: false,
      message: 'The mode switch is on the NOC site only.',
    });
    expect((await ctx.core.cellStatus(0, id))[0].mode).toBe('part15');
  });

  it('audits a wrong name, a revoked cell, and a noc_change refusal, none of which it currently does (review M5)', async () => {
    const id = lancaster();
    setLimit(ctx, 'noc_change', 2);
    await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'wrong', reason: 'test' });
    expect(JSON.parse(listAudit(ctx, 1)[0].detail ?? '{}')).toMatchObject({ outcome: 'wrong_name' });
    await ctx.core.cellRevoke(0, id);
    await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'Lancaster 1', reason: 'test' });
    expect(JSON.parse(listAudit(ctx, 1)[0].detail ?? '{}')).toMatchObject({ outcome: 'revoked' });
    expect(await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'Lancaster 1', reason: 'test' })).toMatchObject({ ok: false });
    expect(listAudit(ctx, 1)[0]).toMatchObject({ action: 'noc.cell.mode.limited' });
  });

  it('limits wrong-name attempts too, so guessing a cell\'s name cannot be unbounded (review M5)', async () => {
    const id = lancaster();
    setLimit(ctx, 'noc_change', 2);
    await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'wrong', reason: 'test' });
    await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'wrong', reason: 'test' });
    expect(await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'Lancaster 1', reason: 'test' })).toEqual({
      ok: false,
      message: 'Too many changes this hour. Please try again later.',
    });
    expect((await ctx.core.cellStatus(0, id))[0].mode).toBe('part15');
  });

  it('gives a clear message on an older core, distinct from a generic "did not answer" (review M5)', async () => {
    const id = lancaster();
    vi.spyOn(ctx.core, 'cellMode').mockRejectedValueOnce(new CoreError('unsupported'));
    expect(await cellModeAction({ core: 'fake', cellId: id, mode: 'part97', confirmName: 'Lancaster 1', reason: 'test' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('oc-core v0.4.0'),
    });
  });
});
