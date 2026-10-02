import { describe, expect, it } from 'vitest';
import { FAKE_CORE_AUDIT_MAX, FakeCore } from '@/core/fake';
import { fakeRadio as radio } from '../helpers/noc-fixture';

// The fake core's NOC operations and their sim* helpers (NOC design §7.1,
// §10): what the demo network and the NOC's tests build on.

const T0 = 1_790_000_000_000;
const N = '+883171746412345';


function core() {
  const clock = { t: T0 };
  const c = new FakeCore(() => clock.t);
  return { c, clock };
}

describe('FakeCore: the NOC operations', () => {
  it("shows a cell's reported radios only while it is online", async () => {
    const { c } = core();
    const id = c.simAddCell('Lancaster 1', 'part15', 1);
    c.simRadio(id, [radio()]);
    expect(await c.cellRadio(0)).toEqual([]);
    c.simCellOnline(id, true);
    expect(await c.cellRadio(0, id)).toEqual([{ ...radio(), cellId: id }]);
    expect(await c.cellRadio(0)).toHaveLength(1);
    c.simCellOnline(id, false);
    expect(await c.cellRadio(0)).toEqual([]);
  });

  it('lists registrations by number with their signal, by cell, after a number', async () => {
    const { c } = core();
    const a = c.simAddCell('A', 'part15', 1);
    const b = c.simAddCell('B', 'part15', 1);
    c.simSubscriber('+883171746410777', 0x11220001, a);
    c.simSubscriber(N, 0x76ad0488, a);
    c.simSubscriber('+883171746455555', 0x33440001, b);
    c.simSubscriber('+883171746466666', 0x55660001, null);
    c.simSignal(N, { rssiDbm: -90, snrDb: 5, heardAt: T0 - 3000 });
    const all = await c.regList(0);
    expect(all.map((r) => r.number)).toEqual(['+883171746410777', N, '+883171746455555']);
    expect(all[1]).toEqual({
      number: N,
      tmidPrefix: '76ad',
      cellId: a,
      registeredAt: T0,
      expiresAt: T0 + 3600_000,
      rssiDbm: -90,
      snrDb: 5,
      heardAt: T0 - 3000,
    });
    expect(all[0]).toMatchObject({ rssiDbm: null, snrDb: null, heardAt: null });
    expect((await c.regList(0, { cellId: a, after: '+883171746410777' })).map((r) => r.number)).toEqual([N]);
    await c.subDisable(0, N);
    expect((await c.regList(0)).map((r) => r.number)).not.toContain(N);
  });

  it('keeps call records by id for cdr.recent, and each side in cdr.list', async () => {
    const { c } = core();
    const r1 = c.simCdr({
      setupAt: T0 - 70_000,
      answerAt: T0 - 67_000,
      endAt: T0 - 10_000,
      cause: 0,
      caller: N,
      called: '+883171746410777',
      cellA: 1,
      cellB: 2,
      legA: 'cell',
      legB: 'cell',
    });
    c.simCdr({ ...r1, answerAt: null, cause: 4, called: '+883150355501234', cellB: null, legB: 'peer' });
    expect((await c.cdrRecent(0, 0, 1000)).map((r) => [r.id, r.legB])).toEqual([
      [1, 'cell'],
      [2, 'peer'],
    ]);
    expect((await c.cdrRecent(0, 1, 1)).map((r) => r.id)).toEqual([2]);
    expect((await c.cdrList(0, '+883171746410777', 0)).map((x) => [x.direction, x.result, x.durationS])).toEqual([['in', 'answered', 57]]);
    expect((await c.cdrList(0, N, 0)).map((x) => x.result)).toEqual(['answered', 'unreachable']);
  });

  it('audits every call as an API record and registrations as REGISTER, by id; never more than its cap', async () => {
    const { c, clock } = core();
    const id = c.simAddCell('A', 'part15', 1);
    c.simSubscriber(N, 0x76ad0488, null);
    clock.t += 1000;
    c.simRegister(N, id);
    await c.subStatus(5, N);
    const recs = await c.auditList(9, { limit: 500 });
    expect(recs.map((r) => [r.event, r.detail, r.number])).toEqual([
      [3, 'register', N],
      [11, 'a5 sub.status ok', N],
    ]);
    expect(recs[0]).toMatchObject({ tmidPrefix: '76ad', cellId: id, at: T0 + 1000 });
    expect((await c.auditList(9, { after: recs[0].id, limit: 500 }))[0].detail).toBe('a5 sub.status ok');
    expect((await c.auditList(9, { events: [3], limit: 500 })).map((r) => r.event)).toEqual([3]);
    for (let i = 0; i < FAKE_CORE_AUDIT_MAX + 10; i++) c.simAuditRecord({ at: T0, event: 11, number: null, tmidPrefix: null, cellId: null, detail: 'x' });
    const page = await c.auditList(9, { limit: 1 });
    expect(page[0].id).toBeGreaterThan(10);
  });

  it('switches a cell mode: the calls on it end, the link comes back at once', async () => {
    const { c, clock } = core();
    const id = c.simAddCell('A', 'part15', 1);
    c.simCellOnline(id, true);
    c.simRadio(id, [radio()]);
    c.simActiveCalls(id, 2);
    clock.t += 60_000;
    await c.cellMode(42, id, 'part97');
    const [cell] = await c.cellStatus(0, id);
    expect(cell).toMatchObject({ mode: 'part97', calls: 0, online: true, lastHeardAt: T0 + 60_000 });
    expect((await c.cellRadio(0, id))[0].reportedAt).toBe(T0 + 60_000);
    c.simActiveCalls(id, 1);
    await c.cellMode(42, id, 'part97'); // already: nothing changes, the call stays
    expect((await c.cellStatus(0, id))[0].calls).toBe(1);
  });

  it('answers ocss.status and core.blocks from what it was given', async () => {
    const { c } = core();
    expect(await c.coreBlocks(0)).toEqual([{ index: 1, homeCore: 1, role: 'home', prefix: '8831717' }]);
    c.simBlocks([{ index: 2, homeCore: 2, role: 'none', prefix: '8831503' }]);
    expect(await c.coreBlocks(0)).toEqual([{ index: 2, homeCore: 2, role: 'none', prefix: '8831503' }]);
    const peer = { coreId: 2, dials: true, state: 'up' as const, since: T0, lastRxAt: T0, lastTxAt: T0, calls: 0, dropped: 0, address: '10.99.0.2:7443' };
    c.simPeers([peer]);
    expect(await c.ocssStatus(0)).toEqual([peer]);
    c.simReset();
    expect(await c.ocssStatus(0)).toEqual([]);
  });

  it('fails every NOC operation alike while it is down', async () => {
    const { c } = core();
    c.simDown('refuse');
    for (const ask of [() => c.cellRadio(0), () => c.regList(0), () => c.cdrRecent(0, 0, 1), () => c.auditList(0, { limit: 1 }), () => c.ocssStatus(0), () => c.coreBlocks(0)]) {
      await expect(ask()).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
});
