import { describe, expect, it } from 'vitest';
import {
  auditListFields,
  auditRow,
  blockRow,
  cdrRecentFields,
  cdrRow,
  cellModeFields,
  ocssRow,
  OP_NOC,
  radioRow,
  regListFields,
  regRow,
} from '@/core/wire-noc';
import { Reader, request, Writer } from '@/core/wire';

// The NOC operations' rows as oc-core's tests/test_oc_api.c lays them out
// (test_cell_radio, test_reg_list, test_cdr_recent, test_audit_list,
// test_ocss_status_and_core_blocks): the same values at the same offsets.
const UNIX0 = 1_790_000_000;
const N1 = [0x88, 0x31, 0x71, 0x74, 0x64, 0x12, 0x34, 0x5f]; // +883171746412345
const N2 = [0x88, 0x31, 0x71, 0x74, 0x64, 0x00, 0x77, 0x7f]; // +883171746400777

const bytes = (f: (w: Writer) => void) => {
  const w = new Writer();
  f(w);
  return w.toBytes();
};

describe('the NOC operations on the wire (oc_api.h 0x10-0x16)', () => {
  it('numbers the operations as oc_api.h does', () => {
    expect(OP_NOC).toEqual({ cellRadio: 0x10, regList: 0x11, cdrRecent: 0x12, auditList: 0x13, ocssStatus: 0x14, coreBlocks: 0x15, cellMode: 0x16 });
  });

  it('reads a cell.radio row (57 bytes)', () => {
    const row = bytes((w) =>
      w
        .u32(3) // cell
        .u8(0) // radio
        .u8(1) // role bs
        .u8(0) // band
        .raw(Uint8Array.from([0, 3, 0])) // fw 0.3.0
        .u8(30) // anchor
        .u8(1) // PPS locked
        .u8(1) // timebase
        .u8(41) // temp
        .u32(3600) // board uptime
        .u32(UNIX0 + 50) // reported at
        .u32(30000)
        .u32(12)
        .u32(4)
        .u32(4)
        .u32(3)
        .u32(2) // schedules, rach, attach, grants, ACK errors, ACK late
        .u16(7) // late slots
        .u16(1) // radio errors
        .u16(0xfffe) // last radio error -2
        .u16(5) // schedule misses
        .u16(0) // UART CRC
        .u8(2), // terminals heard
    );
    expect(row.length).toBe(57);
    expect(radioRow(new Reader(row))).toEqual({
      cellId: 3,
      radio: 0,
      role: 'bs',
      band: 0,
      fw: '0.3.0',
      anchor: 30,
      pps: 'locked',
      timebase: true,
      tempC: 41,
      boardUptimeS: 3600,
      reportedAt: (UNIX0 + 50) * 1000,
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
    });
  });

  it('reads an unknown temperature, an unknown PPS value and a bench role', () => {
    const row = bytes((w) => w.u32(1).u8(0).u8(2).u8(0).raw(new Uint8Array(3)).u8(0).u8(9).u8(0).u8(0x80).raw(new Uint8Array(57 - 14)));
    expect(radioRow(new Reader(row))).toMatchObject({ role: 'bench', pps: 'unlocked', timebase: false, tempC: null, fw: '0.0.0' });
  });

  it('reads reg.list rows (30 bytes): signal reported, and not reported', () => {
    const rows = bytes((w) =>
      w
        .raw(Uint8Array.from(N1))
        .u16(0x76ad)
        .u32(3)
        .u32(UNIX0 + 90)
        .u32(UNIX0 + 3700)
        .u16(-90 & 0xffff)
        .u16(20)
        .u32(UNIX0 + 97)
        .raw(Uint8Array.from(N2))
        .u16(0x1122)
        .u32(3)
        .u32(0)
        .u32(UNIX0 + 3700)
        .u16(0x8000)
        .u16(0x8000)
        .u32(0),
    );
    expect(rows.length).toBe(60);
    const r = new Reader(rows);
    expect(regRow(r)).toEqual({
      number: '+883171746412345',
      tmidPrefix: '76ad',
      cellId: 3,
      registeredAt: (UNIX0 + 90) * 1000,
      expiresAt: (UNIX0 + 3700) * 1000,
      rssiDbm: -90,
      snrDb: 5,
      heardAt: (UNIX0 + 97) * 1000,
    });
    expect(regRow(r)).toEqual({
      number: '+883171746400777',
      tmidPrefix: '1122',
      cellId: 3,
      registeredAt: null,
      expiresAt: (UNIX0 + 3700) * 1000,
      rssiDbm: null,
      snrDb: null,
      heardAt: null,
    });
  });

  it('reads cdr.recent rows (42 bytes): cell to cell, to the echo, unanswered to a peer', () => {
    const row = (id: number, answer: number, cause: number, cellB: number, legs: number) =>
      bytes((w) =>
        w
          .u32(id)
          .u32(UNIX0 + 10)
          .u32(answer)
          .u32(UNIX0 + 70)
          .u8(cause)
          .raw(Uint8Array.from(N1))
          .raw(Uint8Array.from(N2))
          .u32(3)
          .u32(cellB)
          .u8(legs),
      );
    expect(row(1, 0, 0, 0, 0).length).toBe(42);
    expect(cdrRow(new Reader(row(1, UNIX0 + 13, 0, 4, 0x00)))).toEqual({
      id: 1,
      setupAt: (UNIX0 + 10) * 1000,
      answerAt: (UNIX0 + 13) * 1000,
      endAt: (UNIX0 + 70) * 1000,
      cause: 0,
      caller: '+883171746412345',
      called: '+883171746400777',
      cellA: 3,
      cellB: 4,
      legA: 'cell',
      legB: 'cell',
    });
    expect(cdrRow(new Reader(row(2, UNIX0 + 13, 0, 0, 0x01)))).toMatchObject({ cellB: null, legB: 'echo' });
    expect(cdrRow(new Reader(row(3, 0, 4, 0, 0x03)))).toMatchObject({ answerAt: null, cause: 4, legB: 'peer' });
    expect(cdrRow(new Reader(row(4, 0, 0, 0, 0x32)))).toMatchObject({ legA: 'peer', legB: 'playback' });
  });

  it('reads audit.list rows: about a number, and about none', () => {
    const rows = bytes((w) =>
      w
        .u32(17)
        .u32(UNIX0 + 90)
        .u8(3)
        .raw(Uint8Array.from(N1))
        .u16(0x76ad)
        .u32(3)
        .text('test')
        .u32(18)
        .u32(UNIX0 + 91)
        .u8(11)
        .raw(new Uint8Array(8))
        .u16(0)
        .u32(0)
        .text('a0 core.status ok x5 in 60 s'),
    );
    const r = new Reader(rows);
    expect(auditRow(r)).toEqual({
      id: 17,
      at: (UNIX0 + 90) * 1000,
      event: 3,
      number: '+883171746412345',
      tmidPrefix: '76ad',
      cellId: 3,
      detail: 'test',
    });
    expect(auditRow(r)).toEqual({ id: 18, at: (UNIX0 + 91) * 1000, event: 11, number: null, tmidPrefix: null, cellId: null, detail: 'a0 core.status ok x5 in 60 s' });
    expect(r.left).toBe(0);
  });

  it('reads ocss.status rows: a peer this core dials, up; one that dials here, down', () => {
    const rows = bytes((w) =>
      w
        .u16(2)
        .u8(1)
        .u8(4)
        .u32(UNIX0 + 5)
        .u32(UNIX0 + 60)
        .u32(UNIX0 + 61)
        .u8(1)
        .u32(3)
        .text('10.99.0.2:7443')
        .u16(3)
        .u8(0)
        .u8(0)
        .u32(0)
        .u32(0)
        .u32(0)
        .u8(0)
        .u32(0)
        .text('-'),
    );
    const r = new Reader(rows);
    expect(ocssRow(r)).toEqual({
      coreId: 2,
      dials: true,
      state: 'up',
      since: (UNIX0 + 5) * 1000,
      lastRxAt: (UNIX0 + 60) * 1000,
      lastTxAt: (UNIX0 + 61) * 1000,
      calls: 1,
      dropped: 3,
      address: '10.99.0.2:7443',
    });
    expect(ocssRow(r)).toEqual({ coreId: 3, dials: false, state: 'down', since: null, lastRxAt: null, lastTxAt: null, calls: 0, dropped: 0, address: null });
  });

  it('reads core.blocks rows', () => {
    const r = new Reader(bytes((w) => w.u16(1).u16(1).u8(1).text('8831717').u16(2).u16(2).u8(0).text('8831717555')));
    expect(blockRow(r)).toEqual({ index: 1, homeCore: 1, role: 'home', prefix: '8831717' });
    expect(blockRow(r)).toEqual({ index: 2, homeCore: 2, role: 'none', prefix: '8831717555' });
  });

  it('writes the requests as oc_api.c reads them', () => {
    expect([...request(OP_NOC.cellRadio, 1, 0, (w) => w.u32(0))].slice(11)).toEqual([0, 0, 0, 0]);
    expect([...bytes((w) => regListFields(w, 3, undefined))]).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...bytes((w) => regListFields(w, 0, '+883171746400777'))]).toEqual([0, 0, 0, 0, ...N2]);
    expect([...bytes((w) => cdrRecentFields(w, 2, 1))]).toEqual([2, 0, 0, 0, 1, 0]);
    expect([...bytes((w) => auditListFields(w, { after: 1, events: [3], number: '+883171746412345', limit: 10 }))]).toEqual([
      1, 0, 0, 0, 8, 0, 0, 0, ...N1, 10, 0,
    ]);
    expect([...bytes((w) => auditListFields(w, { limit: 500 }))]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xf4, 0x01]);
    expect([...bytes((w) => cellModeFields(w, 3, 'part97'))]).toEqual([3, 0, 0, 0, 2]);
  });

  it('refuses requests the core would refuse, before sending them', () => {
    expect(() => bytes((w) => regListFields(w, 0, '+1717'))).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => bytes((w) => cdrRecentFields(w, 0, 0))).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => bytes((w) => cdrRecentFields(w, 0, 1001))).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => bytes((w) => auditListFields(w, { limit: 501 }))).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => bytes((w) => auditListFields(w, { limit: 5, events: [32] }))).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => bytes((w) => auditListFields(w, { limit: 5, number: 'garbage' }))).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});
