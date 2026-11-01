import { beforeEach, describe, expect, it } from 'vitest';
import { clearQrFlash, dropQr, FLASH_MS, putQr, takeQr } from '@/lib/numbers/qr-flash';

const tok = (number: string, qr = `opencell:2:${number}`) => ({ number, qr, expiresAt: 9e12 });
const A = '+883171746412345';
const B = '+883171746412346';

beforeEach(() => clearQrFlash());

describe('the QR flash (portal spec §7: shown once; P2: for 15 minutes, to the session that asked)', () => {
  it('gives the QR back to its session only, more than once, until 15 minutes pass', () => {
    putQr('s1', tok(A), 1000);
    expect(takeQr('s1', A, 1000)?.qr).toBe(`opencell:2:${A}`);
    expect(takeQr('s1', A, 1000 + FLASH_MS - 1)?.qr).toBe(`opencell:2:${A}`); // a reload still shows it
    expect(takeQr('s2', A, 1000)).toBeNull();
    expect(takeQr('s1', B, 1000)).toBeNull();
    expect(takeQr('s1', A, 1000 + FLASH_MS)).toBeNull();
  });

  it('a new token for the same number replaces the old one', () => {
    putQr('s1', tok(A, 'opencell:2:old'), 0);
    putQr('s1', tok(A, 'opencell:2:new'), 10);
    expect(takeQr('s1', A, 20)?.qr).toBe('opencell:2:new');
  });

  it('keeps at most 8 per session (the oldest go first) and can drop one', () => {
    for (let i = 0; i < 10; i++) putQr('s1', tok(`+8831717464${String(12340 + i)}`), i);
    expect(takeQr('s1', '+883171746412340', 20)).toBeNull();
    expect(takeQr('s1', '+883171746412341', 20)).toBeNull();
    expect(takeQr('s1', '+883171746412342', 20)).not.toBeNull();
    dropQr('s1', '+883171746412342');
    expect(takeQr('s1', '+883171746412342', 20)).toBeNull();
  });

  it('lives on globalThis, so every bundle copy of this module shares it', () => {
    putQr('s1', tok(A), 0);
    expect((globalThis as { __ocQrFlash?: Map<string, unknown> }).__ocQrFlash?.has('s1')).toBe(true);
  });
});
