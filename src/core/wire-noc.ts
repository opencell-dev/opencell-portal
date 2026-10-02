// The NOC's admin-API operations (core v0.4.0; NOC design §7.1; oc-core's
// oc/include/oc_api.h is the reference and tests/test_oc_api.c holds the
// row offsets that tests/unit/core-wire-noc.test.ts repeats). Each list
// answer is n (1) | n rows per frame, as cell.status's.

import { isFullNumber } from './numbers';
import {
  type AuditQuery,
  type CdrRecord,
  type CellMode,
  type CoreAuditRecord,
  type CoreBlock,
  CoreError,
  type LegKind,
  type OcssPeer,
  type OcssState,
  type PpsState,
  type RadioStatus,
  type Registration,
} from './types';
import { bcdNumber, type Reader, type Writer } from './wire';

export const OP_NOC = {
  cellRadio: 0x10,
  regList: 0x11,
  cdrRecent: 0x12,
  auditList: 0x13,
  ocssStatus: 0x14,
  coreBlocks: 0x15,
  cellMode: 0x16,
} as const;

/** oc_core_audit_event_t (oc_core_store.h): the core's audit events, by number. */
export const CORE_AUDIT_EVENTS: Record<number, string> = {
  1: 'ACTIVATE',
  2: 'ACT_FAIL',
  3: 'REGISTER',
  4: 'AUTH_FAIL',
  5: 'RESYNC',
  6: 'LOC_CANCEL',
  7: 'TOKEN_ISSUE',
  8: 'SUB_DISABLE',
  9: 'CELL_REJECT',
  10: 'ADMIN',
  11: 'API',
  12: 'SUB_RELEASE',
  13: 'SUB_ENABLE',
  14: 'PEER_REJECT',
};
export const AUDIT_REGISTER = 3;
export const AUDIT_API = 11;

/** oc_sig's release causes (oc_sig.h). */
export const CAUSES: Record<number, string> = {
  0: 'normal',
  1: 'rejected',
  2: 'busy',
  3: 'no answer',
  4: 'unreachable',
  5: 'network failure',
  6: 'link lost',
};

export const CDR_RECENT_MAX = 1000;
export const AUDIT_LIST_MAX = 500;
export const REG_LIST_MAX = 1000;
/** RSSI and SNR the cell did not report (OC_CORE_STATUS_NONE). */
const SIGNAL_NONE = -32768;
const NO_NUMBER = new Uint8Array(8);

const PPS: PpsState[] = ['unlocked', 'locked', 'holdover'];
const OCSS: OcssState[] = ['down', 'connecting', 'handshake', 'open', 'up'];
const LEG: LegKind[] = ['cell', 'echo', 'playback', 'peer'];
const MODE: Record<CellMode, number> = { part15: 1, part97: 2 };

const ms = (s: number): number | null => (s === 0 ? null : s * 1000);
const tmid = (v: number): string => v.toString(16).padStart(4, '0');

function isZero(b: Uint8Array): boolean {
  return b.every((x) => x === 0);
}

// ---- requests ----

export function cellIdField(w: Writer, cellId?: number): void {
  w.u32(cellId ?? 0);
}

export function regListFields(w: Writer, cellId: number, after: string | undefined): void {
  if (after !== undefined && !isFullNumber(after)) throw new CoreError('invalid', 'after: not a full number');
  w.u32(cellId);
  if (after === undefined) w.raw(NO_NUMBER);
  else w.number(after);
}

export function cdrRecentFields(w: Writer, after: number, limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > CDR_RECENT_MAX) throw new CoreError('invalid', `limit must be 1–${CDR_RECENT_MAX}`);
  w.u32(Math.max(0, Math.floor(after))).u16(limit);
}

export function auditListFields(w: Writer, q: AuditQuery): void {
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > AUDIT_LIST_MAX) throw new CoreError('invalid', `limit must be 1–${AUDIT_LIST_MAX}`);
  let mask = 0;
  for (const e of q.events ?? []) {
    if (!Number.isInteger(e) || e < 0 || e > 31) throw new CoreError('invalid', 'an event is 0–31');
    mask = (mask | (1 << e)) >>> 0;
  }
  if (q.number !== undefined && !isFullNumber(q.number)) throw new CoreError('invalid', 'not a full number');
  w.u32(Math.max(0, Math.floor(q.after ?? 0))).u32(mask);
  if (q.number === undefined) w.raw(NO_NUMBER);
  else w.number(q.number);
  w.u16(q.limit);
}

export function cellModeFields(w: Writer, cellId: number, mode: CellMode): void {
  w.u32(cellId).u8(MODE[mode] ?? 0);
}

// ---- answer rows ----

/** A cell.radio row: 57 bytes. */
export function radioRow(r: Reader): RadioStatus {
  const cellId = r.u32();
  const radio = r.u8();
  const role = r.u8();
  const band = r.u8();
  const fw = [...r.bytes(3)].join('.');
  const anchor = r.u8();
  const pps = r.u8();
  const timebase = r.u8() !== 0;
  const temp = r.i8();
  const boardUptimeS = r.u32();
  const reportedAt = r.u32() * 1000;
  const schedules = r.u32();
  const rach = r.u32();
  const attach = r.u32();
  const grants = r.u32();
  const ackErrors = r.u32();
  const ackLate = r.u32();
  const lateSlots = r.u16();
  const radioErrors = r.u16();
  const lastRadioError = r.i16();
  const scheduleMisses = r.u16();
  const uartCrcErrors = r.u16();
  const terminalsHeard = r.u8();
  return {
    cellId,
    radio,
    role: role === 1 ? 'bs' : role === 2 ? 'bench' : 'unknown',
    band,
    fw,
    anchor,
    pps: PPS[pps] ?? 'unlocked',
    timebase,
    tempC: temp === -128 ? null : temp,
    boardUptimeS,
    reportedAt,
    schedules,
    rach,
    attach,
    grants,
    ackErrors,
    ackLate,
    lateSlots,
    radioErrors,
    lastRadioError,
    scheduleMisses,
    uartCrcErrors,
    terminalsHeard,
  };
}

/** A reg.list row: 30 bytes. */
export function regRow(r: Reader): Registration {
  const number = r.number();
  const prefix = r.u16();
  const cellId = r.u32();
  const registered = r.u32();
  const expires = r.u32();
  const rssi = r.i16();
  const snr = r.i16();
  const heard = r.u32();
  return {
    number,
    tmidPrefix: tmid(prefix),
    cellId,
    registeredAt: ms(registered),
    expiresAt: expires * 1000,
    rssiDbm: rssi === SIGNAL_NONE ? null : rssi,
    snrDb: snr === SIGNAL_NONE ? null : snr / 4,
    heardAt: ms(heard),
  };
}

/** A cdr.recent row: 42 bytes. */
export function cdrRow(r: Reader): CdrRecord {
  const id = r.u32();
  const setup = r.u32();
  const answer = r.u32();
  const end = r.u32();
  const cause = r.u8();
  const caller = r.number();
  const called = r.number();
  const cellA = r.u32();
  const cellB = r.u32();
  const legs = r.u8();
  return {
    id,
    setupAt: setup * 1000,
    answerAt: ms(answer),
    endAt: end * 1000,
    cause,
    caller,
    called,
    cellA: cellA === 0 ? null : cellA,
    cellB: cellB === 0 ? null : cellB,
    legA: LEG[legs >> 4] ?? 'peer',
    legB: LEG[legs & 0x0f] ?? 'peer',
  };
}

/** An audit.list row: 23 bytes and the detail's text. */
export function auditRow(r: Reader): CoreAuditRecord {
  const id = r.u32();
  const at = r.u32() * 1000;
  const event = r.u8();
  const nb = r.bytes(8);
  const prefix = r.u16();
  const cellId = r.u32();
  const detail = r.text();
  const none = isZero(nb);
  return {
    id,
    at,
    event,
    number: none ? null : bcdNumber(nb),
    tmidPrefix: prefix === 0 && none ? null : tmid(prefix),
    cellId: cellId === 0 ? null : cellId,
    detail,
  };
}

/** An ocss.status row: 21 bytes and the address's text. */
export function ocssRow(r: Reader): OcssPeer {
  const coreId = r.u16();
  const dials = r.u8() !== 0;
  const state = r.u8();
  const since = r.u32();
  const rx = r.u32();
  const tx = r.u32();
  const calls = r.u8();
  const dropped = r.u32();
  const address = r.text();
  return {
    coreId,
    dials,
    state: OCSS[state] ?? 'down',
    since: ms(since),
    lastRxAt: ms(rx),
    lastTxAt: ms(tx),
    calls,
    dropped,
    address: address === '-' || address === '' ? null : address,
  };
}

/** A core.blocks row: 5 bytes and the prefix's text. */
export function blockRow(r: Reader): CoreBlock {
  const index = r.u16();
  const homeCore = r.u16();
  const role = r.u8();
  const prefix = r.text();
  return { index, homeCore, role: role === 1 ? 'home' : role === 2 ? 'secondary' : 'none', prefix };
}
