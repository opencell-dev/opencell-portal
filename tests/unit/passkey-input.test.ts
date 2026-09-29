import { describe, expect, it } from 'vitest';
import { optionalPasskeyNameSchema, passkeyNameSchema, passkeyTransportsSchema } from '@/lib/validation';

describe('passkey name (client-supplied)', () => {
  it('trims, and takes 1 to 64 characters', () => {
    expect(passkeyNameSchema.parse('  Phone  ')).toBe('Phone');
    expect(passkeyNameSchema.parse('x'.repeat(64))).toBe('x'.repeat(64));
    expect(passkeyNameSchema.safeParse('x'.repeat(65)).success).toBe(false);
    expect(passkeyNameSchema.safeParse('   ').success).toBe(false);
    expect(passkeyNameSchema.safeParse('').success).toBe(false);
  });

  it('refuses control characters and non-strings', () => {
    expect(passkeyNameSchema.safeParse('Phone\u0000').success).toBe(false);
    expect(passkeyNameSchema.safeParse('Pho\nne').success).toBe(false);
    expect(passkeyNameSchema.safeParse(42).success).toBe(false);
    expect(passkeyNameSchema.safeParse({ toString: () => 'x' }).success).toBe(false);
  });

  it('is optional on the form: blank or missing means no name (the service uses "Passkey")', () => {
    expect(optionalPasskeyNameSchema.parse(undefined)).toBeUndefined();
    expect(optionalPasskeyNameSchema.parse('')).toBeUndefined();
    expect(optionalPasskeyNameSchema.parse('   ')).toBeUndefined();
    expect(optionalPasskeyNameSchema.parse(' Laptop ')).toBe('Laptop');
    expect(optionalPasskeyNameSchema.safeParse('x'.repeat(65)).success).toBe(false);
    expect(optionalPasskeyNameSchema.safeParse(null).success).toBe(false);
    expect(optionalPasskeyNameSchema.safeParse(['Phone']).success).toBe(false);
  });
});

describe('passkey transports (client-supplied)', () => {
  it('keeps the known AuthenticatorTransport values, once each', () => {
    expect(passkeyTransportsSchema.parse(['internal', 'hybrid'])).toEqual(['internal', 'hybrid']);
    expect(passkeyTransportsSchema.parse(['usb', 'nfc', 'ble', 'smart-card', 'cable'])).toEqual(['usb', 'nfc', 'ble', 'smart-card', 'cable']);
    expect(passkeyTransportsSchema.parse(['usb', 'usb'])).toEqual(['usb']);
    expect(passkeyTransportsSchema.parse([])).toEqual([]);
  });

  it('never passes on an unknown value (a hint only: dropped, not stored)', () => {
    expect(passkeyTransportsSchema.parse(['internal', 'telepathy', '<script>'])).toEqual(['internal']);
  });

  it('refuses anything but a short array of short strings', () => {
    expect(passkeyTransportsSchema.safeParse('usb').success).toBe(false);
    expect(passkeyTransportsSchema.safeParse([1, 2]).success).toBe(false);
    expect(passkeyTransportsSchema.safeParse([{ usb: true }]).success).toBe(false);
    expect(passkeyTransportsSchema.safeParse(Array(9).fill('usb')).success).toBe(false);
    expect(passkeyTransportsSchema.safeParse(['u'.repeat(33)]).success).toBe(false);
  });
});
