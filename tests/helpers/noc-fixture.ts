import type { FakeRadio } from '@/core/fake';
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

/** A radio as a cell reports it (oc-core test_cell_radio's values), reported 20 s before AT. */
export const fakeRadio = (o: Partial<FakeRadio> = {}): FakeRadio => ({
  radio: 0,
  role: 'bs',
  band: 0,
  fw: '0.3.0',
  anchor: 30,
  pps: 'locked',
  timebase: true,
  tempC: 41,
  boardUptimeS: 3600,
  reportedAt: AT - 20_000,
  schedules: 30000,
  rach: 12,
  attach: 4,
  grants: 4,
  ackErrors: 3,
  ackLate: 2,
  lateSlots: 7,
  radioErrors: 1,
  lastRadioError: -2,
  scheduleMisses: 5,
  uartCrcErrors: 0,
  terminalsHeard: 2,
  ...o,
});
