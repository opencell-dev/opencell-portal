import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeCore } from '@/core/fake';
import { type CellStatus, CoreError, type CoreHandle } from '@/core/types';
import { allCells, cachedSnapshot, NOC_ACTOR, type NetworkSnapshot, networkSnapshot, summarize } from '@/lib/noc/snapshot';
import { testCtx } from '../helpers/ctx';

afterEach(() => vi.restoreAllMocks());

/** A test context with a second fake core, as OC_CORES=core1,core2 would give. */
function twoCores() {
  const ctx = testCtx();
  const core2 = new FakeCore(ctx.now);
  const cores: CoreHandle[] = [ctx.cores[0], { id: 'core2', where: '10.99.0.2:7444', core: core2 }];
  return { ctx: { ...ctx, cores }, core1: ctx.core, core2 };
}

const cell = (o: Partial<CellStatus>): CellStatus => ({
  cellId: 1,
  name: 'Lancaster 1',
  mode: 'part15',
  group: 1,
  certFpr: 'ab'.repeat(32),
  revoked: false,
  online: true,
  lastHeardAt: 1_000,
  terminals: 0,
  calls: 0,
  ...o,
});

describe('the network snapshot (NOC design §5)', () => {
  it("is each core's status and cells, in config order, with cells sorted by id", async () => {
    const { ctx, core1, core2 } = twoCores();
    const b = await core1.cellAdd(1, 'Bravo', 'part15', 1);
    const a = await core1.cellAdd(1, 'Alpha', 'part97', 2);
    core1.simCellOnline(a, true);
    await core2.cellAdd(1, 'West 1', 'part15', 1);
    const s = await networkSnapshot(ctx);
    expect(s.at).toBe(ctx.now());
    expect(s.cores.map((c) => [c.id, c.status?.cellsTotal, c.cells?.map((x) => x.name)])).toEqual([
      ['fake', 2, ['Bravo', 'Alpha']],
      ['core2', 1, ['West 1']],
    ]);
    expect(s.cores[0].cells?.map((x) => x.cellId)).toEqual([b, a]);
  });

  it('asks as the portal itself (actor 0), both questions at once', async () => {
    const { ctx, core2 } = twoCores();
    const st = vi.spyOn(core2, 'coreStatus');
    const cs = vi.spyOn(core2, 'cellStatus');
    await networkSnapshot(ctx);
    expect(NOC_ACTOR).toBe(0);
    expect(st).toHaveBeenCalledWith(0);
    expect(cs).toHaveBeenCalledWith(0);
  });

  it('shows a core that fails or hangs as unreachable within the deadline, and the others as usual', async () => {
    const { ctx, core2 } = twoCores();
    vi.spyOn(core2, 'coreStatus').mockReturnValue(new Promise(() => {}));
    vi.spyOn(core2, 'cellStatus').mockRejectedValue(new CoreError('unavailable', 'connect ECONNREFUSED'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t0 = Date.now();
    const s = await networkSnapshot(ctx, 200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.cores[0].status).not.toBeNull();
    expect(s.cores[1]).toMatchObject({ id: 'core2', status: null, cells: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('core2 (10.99.0.2:7444) status: no answer within 200 ms'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('core2 (10.99.0.2:7444) cells failed'), expect.any(CoreError));
  });

  it('is shared for the cache time, then asked again', async () => {
    const { ctx, core1 } = twoCores();
    const spy = vi.spyOn(core1, 'coreStatus');
    const a = await cachedSnapshot(ctx, 10_000);
    const b = await cachedSnapshot(ctx, 10_000);
    expect(b).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
    ctx.clock.t += 10_000;
    const c = await cachedSnapshot(ctx, 10_000);
    expect(c).not.toBe(a);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('the summary and its "needs attention" list', () => {
  const at = 10 * 3600_000;
  const snap = (cores: NetworkSnapshot['cores']): NetworkSnapshot => ({ at, deadlineMs: 3000, cores });
  const status = { coreId: 1, name: 'oc-core-1', version: 'v0.3.1', uptimeS: 60, cellsTotal: 0, cellsOnline: 0, subscribers: 4, callsNow: 2 };

  it('adds up cores, cells, terminals, calls and subscribers over the cores that answered', () => {
    const s = summarize(
      snap([
        {
          id: 'core1',
          where: 'x',
          status,
          cells: [cell({ cellId: 1, terminals: 3 }), cell({ cellId: 2, terminals: 2 }), cell({ cellId: 3, revoked: true, online: false, terminals: 0 })],
        },
        { id: 'core2', where: 'y', status: { ...status, coreId: 2, subscribers: 1, callsNow: 1 }, cells: [] },
        { id: 'core3', where: 'z', status: null, cells: null },
      ]),
    );
    expect(s).toMatchObject({ coresUp: 2, coresTotal: 3, cellsEnabled: 2, cellsOnline: 2, cellsRevoked: 1, terminals: 5, calls: 3, subscribers: 5 });
    expect(s.attention).toEqual([{ severity: 'critical', core: 'core3', text: 'core3 did not answer within 3 s' }]);
  });

  it(
    'flags an offline cell as a warning regardless of its last-HELLO age (review I2: a real core only updates ' +
      'this on HELLO, not on every packet, so a duration computed from it cannot be trusted as "how long offline"), ' +
      'and never claims a specific offline duration; a never-connected cell stays info',
    () => {
      const s = summarize(
        snap([
          {
            id: 'core1',
            where: 'x',
            status,
            cells: [
              cell({ cellId: 1, name: 'A', online: false, lastHeardAt: at - 10 * 60_000 }),
              cell({ cellId: 2, name: 'B', online: false, lastHeardAt: at - 3 * 60_000 }),
              cell({ cellId: 3, name: 'C', online: false, lastHeardAt: null, certFpr: null }),
            ],
          },
        ]),
      );
      expect(s.attention).toEqual([
        { severity: 'warning', core: 'core1', cellId: 1, text: 'Cell 1 "A" on core1 offline (last HELLO 10 min ago)' },
        { severity: 'warning', core: 'core1', cellId: 2, text: 'Cell 2 "B" on core1 offline (last HELLO 3 min ago)' },
        { severity: 'info', core: 'core1', cellId: 3, text: 'Cell 3 "C" on core1 has never connected' },
        { severity: 'info', core: 'core1', cellId: 3, text: 'Cell 3 "C" on core1 has no certificate pinned' },
      ]);
    },
  );

  it('warns when a core answered its status but not its cell list, and never flags a revoked cell', () => {
    const s = summarize(
      snap([
        { id: 'core1', where: 'x', status, cells: null },
        { id: 'core2', where: 'y', status, cells: [cell({ revoked: true, online: false, certFpr: null, lastHeardAt: 0 })] },
      ]),
    );
    expect(s.attention).toEqual([{ severity: 'warning', core: 'core1', text: "core1's cell list did not come within 3 s" }]);
    expect(s.cellsRevoked).toBe(1);
  });

  it('lists every cell with its core, cores in config order', () => {
    const cells = allCells(
      snap([
        { id: 'core1', where: 'x', status, cells: [cell({ cellId: 4 })] },
        { id: 'core2', where: 'y', status: null, cells: null },
        { id: 'core3', where: 'z', status, cells: [cell({ cellId: 1 })] },
      ]),
    );
    expect(cells.map((c) => [c.core, c.cellId])).toEqual([
      ['core1', 4],
      ['core3', 1],
    ]);
  });
});
