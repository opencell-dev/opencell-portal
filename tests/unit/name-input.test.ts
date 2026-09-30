import { describe, expect, it } from 'vitest';
import { nameSchema } from '@/lib/validation';

// The sign-up name (final review I2): it ends up in mail and, later, in the
// directory and the admin list, so it is one line of visible plain text.
describe('account name (sign-up form)', () => {
  it('trims, and takes 1 to 80 characters', () => {
    expect(nameSchema.parse('  Ada Lovelace  ')).toBe('Ada Lovelace');
    expect(nameSchema.parse('x'.repeat(80))).toBe('x'.repeat(80));
    expect(nameSchema.safeParse('x'.repeat(81)).success).toBe(false);
    expect(nameSchema.safeParse('   ').success).toBe(false);
    expect(nameSchema.safeParse('').success).toBe(false);
    expect(nameSchema.safeParse(42).success).toBe(false);
  });

  it('keeps ordinary names in any script', () => {
    for (const n of ['Zoë Ñúñez-O’Brien', '李小龍', 'Ada 🚀', 'Jean-Luc Picard Jr.', 'محمد']) expect(nameSchema.parse(n)).toBe(n);
  });

  it.each([
    ['a newline', 'Ada\n\nACTION NEEDED: re-verify at https://evil.example/oc now'],
    ['a carriage return', 'Ada\rBob'],
    ['a tab', 'Ada\tBob'],
    ['a NUL', 'Ada\u0000'],
    ['a line separator', 'Ada Bob'],
    ['a paragraph separator', 'Ada Bob'],
    ['a next-line control', 'Ada\u0085Bob'],
    ['a zero-width space', 'Ad​a'],
    ['a zero-width joiner', 'Ad‍a'],
    ['a right-to-left override', 'Ada ‮ecila'],
    ['a left-to-right isolate', 'Ada ⁦x⁩'],
    ['a soft hyphen', 'Ad­a'],
    ['a byte-order mark inside', 'Ad﻿a'],
  ])('refuses %s', (_what, name) => {
    const r = nameSchema.safeParse(name);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe('Please use plain text for your name, on one line.');
  });
});
