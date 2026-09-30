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

  it('keeps ZWNJ and ZWJ between two letters, as Persian and Indic names need them', () => {
    const persian = '\u0632\u0647\u0631\u0627 \u0639\u0644\u06CC\u200C\u0632\u0627\u062F\u0647'; // Zahra Ali-zadeh: ZWNJ between ی and ز
    const devanagari = '\u0932\u0915\u094D\u200D\u0937\u094D\u092E\u0940'; // Lakshmi: क + virama + ZWJ + ष, a half-form conjunct
    expect(nameSchema.parse(persian)).toBe(persian);
    expect(nameSchema.parse(devanagari)).toBe(devanagari);
  });

  it.each([
    ['a newline', 'Ada\n\nACTION NEEDED: re-verify at https://evil.example/oc now'],
    ['a carriage return', 'Ada\rBob'],
    ['a tab', 'Ada\tBob'],
    ['a NUL', 'Ada\u0000'],
    ['a line separator', 'Ada\u2028Bob'],
    ['a paragraph separator', 'Ada\u2029Bob'],
    ['a next-line control', 'Ada\u0085Bob'],
    ['a zero-width space', 'Ad\u200Ba'],
    ['a zero-width joiner at the start', '\u200DAda'],
    ['a zero-width joiner at the end', 'Ada\u200D'],
    ['a zero-width joiner after a space', 'Ada \u200DBob'],
    ['a zero-width joiner before a space', 'Ada\u200D Bob'],
    ['a zero-width non-joiner before a digit', 'Ada\u200C2'],
    ['two joiners in a row', 'Ad\u200D\u200Da'],
    ['a joiner inside an emoji sequence', 'Ada \u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
    ['a right-to-left override', 'Ada \u202Eecila'],
    ['a left-to-right isolate', 'Ada \u2066x\u2069'],
    ['a soft hyphen', 'Ad\u00ADa'],
    ['a byte-order mark inside', 'Ad\uFEFFa'],
  ])('refuses %s', (_what, name) => {
    const r = nameSchema.safeParse(name);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe('Please use plain text for your name, on one line.');
  });
});
