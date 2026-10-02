import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FakeCore } from '@/core/fake';
import { coreContract } from '../helpers/core-contract';
import { type CellRadioReport, FakeCell } from '../helpers/fake-cell';
import { CORE_DIR, startRealCore } from '../helpers/real-core';

// The same contract for the fake core (always) and a real oc-core over TLS
// (when OC_CORE_DIR names a built opencell-core checkout).
coreContract('fake core', async () => ({ core: new FakeCore(), done: async () => {} }));

describe.skipIf(!CORE_DIR)('against a real oc-core', () => {
  coreContract('oc-core over TLS', () => startRealCore());

  it('audits each call with the portal account it was for', async () => {
    const c = await startRealCore();
    try {
      await c.core.subCreate(4242, '+883171746477777');
      const out = execFileSync(`${CORE_DIR}/build/oc/oc-core`, ['admin', '--socket', c.adminSocket, 'audit', '3']);
      expect(out.toString()).toContain('a4242 sub.create ok');
    } finally {
      await c.done();
    }
  });

  const BOARD: CellRadioReport = {
    radio: 0,
    role: 2,
    band: 1,
    fw: [0, 3, 0],
    anchor: 30,
    pps: 2,
    timebase: 1,
    tempC: 41,
    uptimeS: 3600,
    schedules: 30000,
    rach: 12,
    attach: 4,
    grants: 4,
    ackErr: 3,
    ackLate: 2,
    lateSlots: 7,
    radioErrors: 1,
    schedMisses: 5,
    uartCrc: 9,
    lastRadioErr: -2,
  };

  /** Asks until `ask` gives a non-empty list (the cell's frames reach the core's loop a moment later). */
  async function eventually<T>(ask: () => Promise<T[]>): Promise<T[]> {
    for (let i = 0; ; i++) {
      const got = await ask();
      if (got.length > 0 || i >= 40) return got;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("reads a linked cell's CELL_STATUS back through cell.radio (NOC design §7.3), and the link's end clears it", async () => {
    const c = await startRealCore();
    try {
      const id = await c.core.cellAdd(7, 'Bench 1', 'part15', 1);
      const cell = await FakeCell.hello(c.cellSocket, id);
      const t0 = Date.now();
      cell.report([BOARD], [{ tmid: 0x76ad0488, rssiDbm: -61, snrQdb: 38, heardAgeS: 3, ulRx: 40 }]);
      const [r] = await eventually(() => c.core.cellRadio(7, id));
      expect(r).toEqual({
        cellId: id,
        radio: 0,
        role: 'bench',
        band: 1,
        fw: '0.3.0',
        anchor: 30,
        pps: 'holdover',
        timebase: true,
        tempC: 41,
        boardUptimeS: 3600,
        reportedAt: expect.any(Number),
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
        uartCrcErrors: 9,
        terminalsHeard: 1,
      });
      expect(Math.abs(r.reportedAt - t0)).toBeLessThan(3000);
      expect((await c.core.cellStatus(7, id))[0].online).toBe(true);
      expect(await c.core.cellRadio(7)).toHaveLength(1);
      // The mode switch drops the link (oc-core admin cell mode's behaviour); the report goes with it.
      await c.core.cellMode(42, id, 'part97');
      await cell.closed;
      expect(await c.core.cellRadio(7, id)).toEqual([]);
      const out = execFileSync(`${CORE_DIR}/build/oc/oc-core`, ['admin', '--socket', c.adminSocket, 'audit', '5']).toString();
      expect(out).toContain('a42 cell.mode ok part97');
    } finally {
      await c.done();
    }
  });

  it('done() does not hang on a process that already died by a signal (review M5)', async () => {
    const c = await startRealCore();
    process.kill(c.pid, 'SIGKILL');
    // Give the OS time to reap it, so the ChildProcess's own 'exit' event has
    // already fired by the time done() looks — the scenario a clean SIGTERM
    // exit (exitCode set) never hits, since only signalCode gets set here.
    await new Promise((r) => setTimeout(r, 300));
    await c.done();
    await c.done(); // idempotent: must not hang waiting on a stale 'exit' listener
  }, 10_000);
});
