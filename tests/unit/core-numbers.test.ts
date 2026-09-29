import { describe, expect, it } from 'vitest';
import { exchangeOf, isAssignable, isExchange, isFullNumber, numberBcd } from '@/core/numbers';

describe('number rules (numbering-plan.md, portal spec §4.2)', () => {
  it('knows the full form: +883 1 NPA NXX and five digits', () => {
    expect(isFullNumber('+883171746401234')).toBe(true);
    expect(isFullNumber('+88317174640123')).toBe(false); // 14 digits
    expect(isFullNumber('+883117464012345')).toBe(false); // NPA starting with 1
    expect(isFullNumber('+883171714601234')).toBe(false); // NXX starting with 1
    expect(isFullNumber('883171746401234')).toBe(false);
  });

  it('assigns 01000–99998 except 09911', () => {
    expect(isAssignable('+883171746401000')).toBe(true);
    expect(isAssignable('+883171746499998')).toBe(true);
    for (const s of ['00000', '00100', '00911', '00999', '09911', '99999']) {
      expect(isAssignable(`+8831717464${s}`)).toBe(false);
    }
    expect(isAssignable('not a number')).toBe(false);
  });

  it('names the exchange of a number', () => {
    expect(exchangeOf('+883171746401234')).toBe('+8831717464');
    expect(isExchange('+8831717464')).toBe(true);
    expect(isExchange('+8831717')).toBe(false);
  });

  it('encodes the 8-byte BCD form with 0xF filler', () => {
    expect(Buffer.from(numberBcd('+883160655501234')).toString('hex')).toBe('883160655501234f');
  });
});
