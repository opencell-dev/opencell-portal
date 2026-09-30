import { describe, expect, it } from 'vitest';
import { CoreError } from '@/core/types';
import { answerError, bcdNumber, cdrResult, FrameReader, OP, parseAnswer, Reader, request } from '@/core/wire';

// The golden frames of oc-core's tests/test_oc_api.c (test_the_golden_frames):
// both sides must produce and read exactly these bytes.
const NUM_CHECK_REQ = [0x00, 0x11, 0x02, 0x07, 0x00, 0x00, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x88, 0x31, 0x71, 0x74, 0x64, 0x12, 0x34, 0x5f];
const NUM_CHECK_ANS = [0x00, 0x07, 0x82, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00];
const NOT_FOUND_ANS = [
  0x00, 0x17, 0x85, 0x08, 0x00, 0x00, 0x00, 0x11, 0x10, ...Buffer.from('not a subscriber'),
];

describe('the admin API frames (oc_api.h)', () => {
  it('encodes a request as oc-core expects it', () => {
    const f = request(OP.numCheck, 7, 42, (w) => w.number('+883171746412345'));
    expect([...f]).toEqual(NUM_CHECK_REQ);
  });

  it('reads an answer as oc-core writes it', () => {
    const a = parseAnswer(Uint8Array.from(NUM_CHECK_ANS));
    expect(a).toMatchObject({ op: OP.numCheck, req: 7, status: 0 });
    expect(new Reader(a.body).u8()).toBe(0); // free
  });

  it('turns an error answer into a CoreError with its code and message', () => {
    const a = parseAnswer(Uint8Array.from(NOT_FOUND_ANS));
    const e = answerError(a);
    expect(e).toBeInstanceOf(CoreError);
    expect(e.code).toBe('not_found');
    expect(e.message).toBe('not a subscriber');
    expect(answerError({ op: 1, req: 1, status: 0x17, body: new Uint8Array() }).code).toBe('unsupported');
    expect(answerError({ op: 1, req: 1, status: 0x99, body: new Uint8Array() }).code).toBe('unavailable');
  });

  it('splits a stream into frames whatever the chunks', () => {
    const r = new FrameReader();
    const both = [...NUM_CHECK_ANS, ...NOT_FOUND_ANS];
    expect(r.push(Uint8Array.from(both.slice(0, 1)))).toEqual([]);
    const out = [...r.push(Uint8Array.from(both.slice(1, 12))), ...r.push(Uint8Array.from(both.slice(12)))];
    expect(out.map((f) => [...f])).toEqual([NUM_CHECK_ANS, NOT_FOUND_ANS]);
  });

  it('refuses a frame length no frame can have', () => {
    expect(() => new FrameReader().push(Uint8Array.from([0x02, 0x00]))).toThrow(CoreError);
    expect(() => new FrameReader().push(Uint8Array.from([0x00, 0x00]))).toThrow(CoreError);
  });

  it('reads BCD numbers back to the full form', () => {
    expect(bcdNumber(Uint8Array.from([0x88, 0x31, 0x71, 0x74, 0x64, 0x12, 0x34, 0x5f]))).toBe('+883171746412345');
    expect(() => bcdNumber(Uint8Array.from([0x8a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toThrow(CoreError);
  });

  it('refuses a request that would not fit a frame', () => {
    expect(() => request(OP.cellAdd, 1, 1, (w) => w.text('x'.repeat(256)))).toThrow(CoreError);
  });

  it('says what a call record means', () => {
    expect(cdrResult(100, 0)).toBe('answered');
    expect(cdrResult(0, 2)).toBe('busy');
    expect(cdrResult(0, 1)).toBe('busy');
    expect(cdrResult(0, 3)).toBe('no_answer');
    expect(cdrResult(0, 0)).toBe('no_answer');
    expect(cdrResult(0, 4)).toBe('unreachable');
    expect(cdrResult(0, 5)).toBe('failed');
  });
});
