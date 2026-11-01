import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAddition, delegatePublicKey, signAddition } from '@/lib/numbers/route-delegate';

// OCSS spec §5.5: RFC 8032 §7.1 TEST 1's key, as tests/test_oc_rtbl.c pins it.
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const BLOB = '4f4352410107000000010060a3e66ad75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a01343732c7010555532d4e43';
const SIG = '0fb6cb54a4472f1fe3a1aa09e1ecc95cd976811a2dcc390fc9b0a5f81b0b2469e78aa3025efdf17ca806397f9e1deb41cae644ae09bc5f06c2d5e0bdd630fb0b';
const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(`302e020100300506032b657004220420${SEED}`, 'hex').toString('base64')}\n-----END PRIVATE KEY-----\n`;
const delegate = Buffer.from(PUB, 'hex');

describe("the delegate's addition (OCSS spec §3.2, §5.5)", () => {
  it('reproduces the blob of the test vector', () => {
    const blob = buildAddition({ rootVersion: 7, seq: 1, issued: 1793500000, delegate, blocks: [{ npa: '472', index: 455, state: 'US-NC' }] });
    expect(blob.toString('hex')).toBe(BLOB);
    expect(blob.length).toBe(59);
  });

  it('reproduces the signature of the test vector', () => {
    expect(signAddition(Buffer.from(BLOB, 'hex'), pem).toString('hex')).toBe(SIG);
  });

  it('reproduces the public key', () => {
    expect(delegatePublicKey(pem).toString('hex')).toBe(PUB);
  });

  it('a signature verifies with the public key it names, and only over the whole blob', () => {
    const k = generateKeyPairSync('ed25519');
    const keyPem = k.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const raw = delegatePublicKey(keyPem);
    const blob = buildAddition({ rootVersion: 1, seq: 2, issued: 1, delegate: raw, blocks: [{ npa: '206', index: 9, state: 'US-WA' }, { npa: '345', index: 10, state: 'KY' }] });
    const sig = signAddition(blob, keyPem);
    expect(verify(null, blob, createPublicKey(keyPem), sig)).toBe(true);
    expect(verify(null, blob.subarray(1), createPublicKey(keyPem), sig)).toBe(false);
    expect(blob.subarray(15, 47).equals(raw)).toBe(true);
    expect(blob[47]).toBe(2);
    expect(blob.subarray(48).toString('latin1')).toBe('206\x09\x00\x05US-WA345\x0a\x00\x02KY');
  });

  it('holds 16 blocks within the 400 bytes a core takes', () => {
    const blocks = Array.from({ length: 16 }, (_, i) => ({ npa: String(220 + i * 2), index: 500 + i, state: 'US-NC' }));
    expect(buildAddition({ rootVersion: 1, seq: 1, issued: 1, delegate, blocks }).length).toBeLessThanOrEqual(400);
  });

  it.each([
    ['no blocks', { blocks: [] }],
    ['17 blocks', { blocks: Array.from({ length: 17 }, (_, i) => ({ npa: String(220 + i), index: 500 + i, state: 'US-NC' })) }],
    ['a bad NPA', { blocks: [{ npa: '411', index: 1, state: 'US-NC' }] }],
    ['NPA 883', { blocks: [{ npa: '883', index: 1, state: 'US-NC' }] }],
    ['a bare state', { blocks: [{ npa: '472', index: 1, state: 'North Carolina' }] }],
    ['an index out of range', { blocks: [{ npa: '472', index: 70000, state: 'US-NC' }] }],
    ['seq 0', { seq: 0 }],
    ['a short delegate', { delegate: Buffer.alloc(31) }],
  ])('refuses %s', (_what, over) => {
    expect(() => buildAddition({ rootVersion: 1, seq: 1, issued: 1, delegate, blocks: [{ npa: '472', index: 1, state: 'US-NC' }], ...over })).toThrow();
  });
});
