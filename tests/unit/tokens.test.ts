import { describe, expect, it } from 'vitest';
import { hashToken, newToken } from '@/lib/tokens';

describe('tokens', () => {
  it('makes 256-bit url-safe tokens, different every time', () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
  });

  it('stores only a SHA-256 of a token', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
