import { describe, expect, it } from 'vitest';
import { CoreError, isCoreError } from '@/core/types';

// Review I1: Next's production build can load src/core/types.ts more than
// once (one copy per server bundle), so a CoreError thrown by one copy
// fails `instanceof CoreError` against another copy's class. isCoreError
// uses a Symbol.for brand instead, so it holds across module copies: a
// "look-alike" class with the same name, message and code (standing in for
// a CoreError thrown by a different module copy) still reads as one.
describe('isCoreError (review I1)', () => {
  it('recognizes a real CoreError', () => {
    const e = new CoreError('not_found', 'no subscriber +883171746412345');
    expect(isCoreError(e)).toBe(true);
    expect(isCoreError(e) && e.code).toBe('not_found');
  });

  it('recognizes a look-alike class with the same brand, not just the real class (instanceof would fail here)', () => {
    const BRAND = Symbol.for('opencell.CoreError');
    class OtherCoreError extends Error {
      readonly [BRAND] = true;
      constructor(readonly code: string) {
        super(code);
        this.name = 'CoreError';
      }
    }
    const e: unknown = new OtherCoreError('rate_limited');
    expect(e instanceof CoreError).toBe(false);
    expect(isCoreError(e)).toBe(true);
    expect(isCoreError(e) && e.code).toBe('rate_limited');
  });

  it('refuses anything without the brand: a plain Error, null, a non-error object', () => {
    expect(isCoreError(new Error('unavailable'))).toBe(false);
    expect(isCoreError(null)).toBe(false);
    expect(isCoreError(undefined)).toBe(false);
    expect(isCoreError({ code: 'not_found', message: 'no subscriber' })).toBe(false);
    expect(isCoreError('not_found')).toBe(false);
  });
});
