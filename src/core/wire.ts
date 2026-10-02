// The core admin API's frames (portal spec §7; oc-core's oc/include/oc_api.h
// is the reference and its tests/test_oc_api.c holds the golden frames that
// tests/unit/core-wire.test.ts repeats): len (2, big-endian, counting type
// and body) | type (1) | body, a frame at most 512 bytes; fields
// little-endian; numbers 8 BCD bytes; text is len (1) | UTF-8.
// A request is op | req (4) | actor (4) | fields; its answer 0x80 | op |
// req | status (1) | result, or a message for any status but ok/more.

import { numberBcd } from './numbers';
import { type Cdr, CoreError, type CoreErrorCode } from './types';

export const FRAME_MAX = 512;

export const OP = {
  numFree: 0x01,
  numCheck: 0x02,
  subCreate: 0x03,
  subReissue: 0x04,
  subStatus: 0x05,
  subRelease: 0x06,
  subDisable: 0x07,
  subEnable: 0x08,
  cdrList: 0x09,
  cellAdd: 0x0a,
  cellSetCert: 0x0b,
  cellRevoke: 0x0c,
  cellStatus: 0x0d,
  coreStatus: 0x0e,
  routeOffer: 0x0f,
} as const;

export const ANSWER = 0x80;
export const STATUS_OK = 0x00;
export const STATUS_MORE = 0x01;

/** The core's error statuses, by the name CoreError uses. */
const ERRORS: Record<number, CoreErrorCode> = {
  0x10: 'invalid',
  0x11: 'not_found',
  0x12: 'taken',
  0x13: 'not_assignable',
  0x14: 'not_unactivated',
  0x15: 'rate_limited',
  0x16: 'unavailable',
  0x17: 'unsupported',
};

export class Writer {
  private readonly bytes: number[] = [];

  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }

  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }

  raw(b: Uint8Array): this {
    for (const x of b) this.bytes.push(x);
    return this;
  }

  text(s: string): this {
    const b = Buffer.from(s, 'utf8');
    if (b.length > 255) throw new CoreError('invalid', 'text longer than 255 bytes');
    return this.u8(b.length).raw(b);
  }

  number(n: string): this {
    return this.raw(numberBcd(n));
  }

  get length(): number {
    return this.bytes.length;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** A request frame: op, req, actor, then what `fields` writes. */
export function request(op: number, req: number, actor: number, fields: (w: Writer) => void = () => {}): Uint8Array {
  const w = new Writer().u16(0).u8(op).u32(req).u32(actor);
  fields(w);
  const f = w.toBytes();
  if (f.length > FRAME_MAX) throw new CoreError('invalid', 'request too long');
  f[0] = (f.length - 2) >> 8;
  f[1] = (f.length - 2) & 0xff;
  return f;
}

export class Reader {
  private off = 0;

  constructor(private readonly b: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (this.off + n > this.b.length) throw new CoreError('unavailable', 'answer cut short');
    const out = this.b.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0];
  }

  u16(): number {
    const b = this.take(2);
    return b[0] | (b[1] << 8);
  }

  u32(): number {
    const b = this.take(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  bytes(n: number): Uint8Array {
    return this.take(n);
  }

  text(): string {
    return Buffer.from(this.take(this.u8())).toString('utf8');
  }

  number(): string {
    return bcdNumber(this.take(8));
  }

  get left(): number {
    return this.b.length - this.off;
  }
}

/** "+883…" from 8 BCD bytes: digits high nibble first, up to the first 0xF. */
export function bcdNumber(b: Uint8Array): string {
  let s = '+';
  for (const byte of b) {
    for (const d of [byte >> 4, byte & 0x0f]) {
      if (d === 0x0f) return s;
      if (d > 9) throw new CoreError('unavailable', 'not a number');
      s += String(d);
    }
  }
  return s;
}

export interface Answer {
  op: number;
  req: number;
  status: number;
  /** After the status: the result, or (an error status) the message. */
  body: Uint8Array;
}

/** A whole answer frame (its len included). */
export function parseAnswer(frame: Uint8Array): Answer {
  if (frame.length < 8) throw new CoreError('unavailable', 'answer cut short');
  const r = new Reader(frame.subarray(2));
  const op = r.u8();
  if (!(op & ANSWER)) throw new CoreError('unavailable', 'not an answer');
  const req = r.u32();
  const status = r.u8();
  return { op: op & 0x7f, req, status, body: frame.subarray(8) };
}

/** The CoreError an error answer stands for. */
export function answerError(a: Answer): CoreError {
  let message = '';
  try {
    message = new Reader(a.body).text();
  } catch {
    // no message: the code alone
  }
  const code = ERRORS[a.status] ?? 'unavailable';
  return new CoreError(code, message || code);
}

/** What a CDR row's answer time and oc_sig cause mean to a person. */
export function cdrResult(answer: number, cause: number): Cdr['result'] {
  if (answer !== 0) return 'answered';
  switch (cause) {
    case 1: // rejected
    case 2: // busy
      return 'busy';
    case 0: // the caller hung up first
    case 3: // no answer
      return 'no_answer';
    case 4:
      return 'unreachable';
    default:
      return 'failed';
  }
}

/** Whole frames out of a byte stream, as it arrives. */
export class FrameReader {
  private buf = Buffer.alloc(0);

  /** The frames completed by chunk; throws on a length no frame can have. */
  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    const out: Uint8Array[] = [];
    while (this.buf.length >= 2) {
      const len = (this.buf[0] << 8) | this.buf[1];
      if (len === 0 || len + 2 > FRAME_MAX) throw new CoreError('unavailable', 'a frame of an impossible length');
      if (this.buf.length < len + 2) break;
      out.push(Uint8Array.from(this.buf.subarray(0, len + 2)));
      this.buf = this.buf.subarray(len + 2);
    }
    return out;
  }
}
