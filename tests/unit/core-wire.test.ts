import { describe, expect, it } from 'vitest';
import { CoreError } from '@/core/types';
import { answerError, bcdNumber, cdrResult, FrameReader, OP, parseAnswer, Reader, request, routeOfferedResult, routeOfferFields, routeStatusResult, subStatusResult } from '@/core/wire';

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

// OCSS spec §5.5: the vector, as tests/test_oc_rtbl.c pins it.
const VECTOR_BLOB = Buffer.from('4f4352410107000000010060a3e66ad75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a01343732c7010555532d4e43', 'hex');
const VECTOR_SIG = Buffer.from('0fb6cb54a4472f1fe3a1aa09e1ecc95cd976811a2dcc390fc9b0a5f81b0b2469e78aa3025efdf17ca806397f9e1deb41cae644ae09bc5f06c2d5e0bdd630fb0b', 'hex');

describe('route.offer and route.status (OCSS spec §5.1, §5.2, §5.5)', () => {
  it('encodes the spec\'s route.offer frame exactly', () => {
    const f = request(OP.routeOffer, 1, 0, (w) => routeOfferFields(w, 7, VECTOR_BLOB, VECTOR_SIG));
    const head = Buffer.from('008a0f0100000000000000070000003b00', 'hex');
    expect(Buffer.from(f).toString('hex')).toBe(Buffer.concat([head, VECTOR_BLOB, VECTOR_SIG]).toString('hex'));
  });

  it('refuses a blob or signature the core could never take, before sending', () => {
    const w = () => request(OP.routeOffer, 1, 0, (x) => routeOfferFields(x, 7, Buffer.alloc(401), VECTOR_SIG));
    expect(w).toThrow(CoreError);
    expect(() => request(OP.routeOffer, 1, 0, (x) => routeOfferFields(x, 7, Buffer.alloc(0), VECTOR_SIG))).toThrow(CoreError);
    expect(() => request(OP.routeOffer, 1, 0, (x) => routeOfferFields(x, 7, VECTOR_BLOB, Buffer.alloc(63)))).toThrow(CoreError);
  });

  it('decodes route.offer\'s answer: root version, seq, blocks, new', () => {
    const r = new Reader(Uint8Array.from([7, 0, 0, 0, 1, 0, 0xc7, 0x01, 1]));
    expect(routeOfferedResult(r)).toEqual({ rootVersion: 7, seq: 1, blocks: 455, isNew: true });
    expect(routeOfferedResult(new Reader(Uint8Array.from([7, 0, 0, 0, 1, 0, 0xc7, 0x01, 0])))).toMatchObject({ isNew: false });
  });

  it('decodes route.status, with its op 0x17; a delegation end of 0 is none', () => {
    expect(OP.routeStatus).toBe(0x17);
    const signed = Uint8Array.from([1, 1, 0, 0, 0, 2, 0, 0xc6, 0x01, 0xc8, 0x01, 0x0f, 0x4b, 0xe6, 0x6a]);
    expect(routeStatusResult(new Reader(signed))).toEqual({ signed: true, rootVersion: 1, seq: 2, blocks: 454, maxIdx: 456, delegateNotAfter: 0x6ae64b0f * 1000 });
    const plain = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0]);
    expect(routeStatusResult(new Reader(plain))).toEqual({ signed: false, rootVersion: 0, seq: 0, blocks: 1, maxIdx: 1, delegateNotAfter: null });
  });
});

describe('sub.status (OCSS spec §5.6)', () => {
  const bcd = [0x88, 0x31, 0x71, 0x74, 0x64, 0x12, 0x34, 0x5f];
  // number 8, activated, disabled, expiry 4, registered, cell 4, TMID top 2, last seen 4
  const v070 = (registered: number, cell: number) => [...bcd, 1, 0, 0, 0, 0, 0, registered, cell, 0, 0, 0, 0xad, 0x76, 0x60, 0xa3, 0xe6, 0x6a];

  it('reads the serving core (little-endian, offset 25) as a pair with the cell', () => {
    const st = subStatusResult(new Reader(Uint8Array.from([...v070(1, 3), 0x02, 0x00])));
    expect(st).toMatchObject({ number: '+883171746412345', state: 'activated', registered: true, cellId: 3, servingCore: 2, tmidPrefix: '76ad' });
    expect(subStatusResult(new Reader(Uint8Array.from([...v070(1, 3), 0x02, 0x01]))).servingCore).toBe(0x0102);
  });

  it('0 is no serving core (not registered)', () => {
    expect(subStatusResult(new Reader(Uint8Array.from([...v070(0, 0), 0, 0])))).toMatchObject({ registered: false, cellId: null, servingCore: null });
  });

  it('a v0.7.0 core answers 25 bytes: the field is unknown, not an error', () => {
    const st = subStatusResult(new Reader(Uint8Array.from(v070(1, 3))));
    expect(st).toMatchObject({ registered: true, cellId: 3, servingCore: null });
  });
});
