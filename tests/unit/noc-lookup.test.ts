import { describe, expect, it } from 'vitest';
import { normalizeNumber } from '@/lib/noc/lookup';

// normalizeNumber hardening (follow-up to the final review, 2026-10-02): a
// pasted number can carry far more than spaces, dots and brackets --
// invisible formatting characters, Unicode spaces and dashes other than the
// ASCII ones, and fullwidth digits an IME or a phone's own dialer produced.
// Keep only ASCII digits and one leading '+'; drop everything else outright
// rather than trying to special-case every character that isn't one.

const N = '+883171746412345';

/** `s`'s digits and '+' written in their fullwidth (U+FF0B, U+FF10-FF19) forms. */
function fullwidth(s: string): string {
  return [...s]
    .map((c) => (c === '+' ? '＋' : String.fromCodePoint(c.charCodeAt(0) - 0x30 + 0xff10)))
    .join('');
}

describe('normalizeNumber: what a paste or an IME can carry', () => {
  it('still accepts the plain forms (spaces, dashes, dots, brackets, no leading +)', () => {
    expect(normalizeNumber(' +883-1-717-464-12345 ')).toBe(N);
    expect(normalizeNumber('883 1 717 464 12345')).toBe(N);
    expect(normalizeNumber('(883) 1.717.464.12345')).toBe(N);
    expect(normalizeNumber('+1 717 464 1234')).toBeNull();
    expect(normalizeNumber('')).toBeNull();
  });

  it('strips invisible formatting characters (zero-width space/joiners, the word joiner, a BOM)', () => {
    expect(normalizeNumber('+883​171746412345')).toBe(N); // ZERO WIDTH SPACE
    expect(normalizeNumber('+883‌171746412345')).toBe(N); // ZERO WIDTH NON-JOINER
    expect(normalizeNumber('+883‍171746412345')).toBe(N); // ZERO WIDTH JOINER
    expect(normalizeNumber('+883⁠171746412345')).toBe(N); // WORD JOINER
    expect(normalizeNumber('﻿+883171746412345')).toBe(N); // ZERO WIDTH NO-BREAK SPACE / BOM
  });

  it('strips every Unicode space, not just the ASCII one', () => {
    expect(normalizeNumber('+883 171746412345')).toBe(N); // NO-BREAK SPACE
    expect(normalizeNumber('+883 171746412345')).toBe(N); // EM SPACE
    expect(normalizeNumber('+883 171746412345')).toBe(N); // THIN SPACE
    expect(normalizeNumber('+883　171746412345')).toBe(N); // IDEOGRAPHIC SPACE
  });

  it('strips dashes of every kind, not just the ASCII hyphen-minus', () => {
    expect(normalizeNumber('+883‑1‒717–464—12345')).toBe(N); // hyphen, figure dash, en dash, em dash
    expect(normalizeNumber('+883−171746412345')).toBe(N); // MINUS SIGN
  });

  it('maps fullwidth digits and the fullwidth plus sign (NFKC) before keeping only digits', () => {
    expect(normalizeNumber(fullwidth(N))).toBe(N);
    expect(normalizeNumber(`${fullwidth('+883')}1 717 464 12345`)).toBe(N);
  });

  it('is never confused by a stray or repeated "+": exactly one leading "+" either way', () => {
    expect(normalizeNumber('+++883171746412345')).toBe(N);
    expect(normalizeNumber('883+171746412345')).toBe(N);
    expect(normalizeNumber('+')).toBeNull();
  });
});
