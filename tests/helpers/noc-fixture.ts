import type { CellStatus, CoreStatus } from '@/core/types';
import type { NetworkSnapshot } from '@/lib/noc/snapshot';

// A small network for the NOC's view tests: core1 answering with two cells
// (one online, one offline for 20 min), core2 unreachable.

export const AT = 1_790_000_000_000;

export const st = (o: Partial<CoreStatus>): CoreStatus => ({
  coreId: 1,
  name: 'oc-core-1',
  version: 'v0.3.1',
  uptimeS: 3 * 3600 + 120,
  cellsTotal: 2,
  cellsOnline: 1,
  subscribers: 12,
  callsNow: 2,
  ...o,
});

export const cell = (o: Partial<CellStatus>): CellStatus => ({
  cellId: 1,
  name: 'Lancaster 1',
  mode: 'part15',
  group: 1,
  certFpr: `ab12cd34${'0'.repeat(52)}9f0e`,
  revoked: false,
  online: true,
  lastHeardAt: AT - 30_000,
  terminals: 7,
  calls: 1,
  ...o,
});

export const snap: NetworkSnapshot = {
  at: AT,
  deadlineMs: 3000,
  cores: [
    {
      id: 'core1',
      where: '10.0.0.60:7444',
      status: st({}),
      cells: [cell({}), cell({ cellId: 2, name: 'Lancaster 2', mode: 'part97', online: false, lastHeardAt: AT - 20 * 60_000, terminals: 0, calls: 0 })],
    },
    { id: 'core2', where: '10.99.0.2:7444', status: null, cells: null },
  ],
};
