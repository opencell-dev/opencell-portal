import { describe, expect, it } from 'vitest';
import { parseTyped, TYPE_HINT } from '@/lib/numbers/input';

// Review Focus: vanity input in any human form is normalized, or gets a clear message.
describe('parseTyped', () => {
  it.each([
    ['717-464-12345', '+883171746412345'],
    ['(717) 464-12345', '+883171746412345'],
    ['717.464.12345', '+883171746412345'],
    ['+883 1 717 464 12345', '+883171746412345'],
    ['+8831 717 464 12345', '+883171746412345'],
    ['883 1717 46412345', '+883171746412345'],
    ['８８３１７１７４６４１２３４５', '+883171746412345'], // full-width digits
    ['＋８８３ １ ７１７－４６４－１２３４５', '+883171746412345'],
    ['  71746412345 ', '+883171746412345'],
    ['717–464–12345', '+883171746412345'], // en dashes
    ['717\u2011464\u201112345', '+883171746412345'], // non-breaking hyphens
  ])('%s is the number %s', (s, number) => {
    expect(parseTyped(s)).toEqual({ kind: 'number', number });
  });

  it('exchanges and area codes', () => {
    expect(parseTyped('717-464')).toEqual({ kind: 'exchange', exchange: '+8831717464' });
    expect(parseTyped('(717) 464')).toEqual({ kind: 'exchange', exchange: '+8831717464' });
    expect(parseTyped('+883 1 717 464')).toEqual({ kind: 'exchange', exchange: '+8831717464' });
    expect(parseTyped('717')).toEqual({ kind: 'npa', npa: '717' });
    expect(parseTyped('７１７')).toEqual({ kind: 'npa', npa: '717' });
  });

  it('places', () => {
    expect(parseTyped('  Lancaster,  PA ')).toEqual({ kind: 'text', text: 'Lancaster, PA' });
    expect(parseTyped('Montréal')).toEqual({ kind: 'text', text: 'Montréal' });
    expect(parseTyped("St. John's")).toEqual({ kind: 'text', text: "St. John's" });
  });

  it('a 10-digit phone number says how OpenCell numbers differ', () => {
    for (const s of ['(717) 464-1234', '717-464-1234', '7174641234', '+883 1 717 464 1234']) {
      const t = parseTyped(s);
      expect(t.kind).toBe('bad');
      expect(t.kind === 'bad' && t.message).toMatch(/type the 11 digits after \+883 1/);
    }
  });

  it('refuses what cannot be an OpenCell number, with a reason', () => {
    const msg = (s: string) => {
      const t = parseTyped(s);
      return t.kind === 'bad' ? t.message : `not bad: ${t.kind}`;
    };
    expect(msg('+1 717 464 1234')).toMatch(/start with \+883 1/);
    expect(msg('+44 20 7946 0000')).toMatch(/start with \+883 1/);
    expect(msg('117-464-12345')).toMatch(/2 to 9/); // NPA 1xx
    expect(msg('717-411')).toMatch(/2 to 9|N11|11/); // N11 exchange
    expect(msg('911')).toMatch(/11/);
    expect(msg('12')).toBe(TYPE_HINT);
    expect(msg('')).toBe(TYPE_HINT);
    expect(msg('717#464')).toBe(TYPE_HINT);
    expect(msg('7'.repeat(30))).toBe(TYPE_HINT);
    expect(msg('a'.repeat(65))).toMatch(/shorter/);
  });
});
