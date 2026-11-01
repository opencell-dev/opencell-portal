import { isExchange, isFullNumber } from '@/core/numbers';

// What a subscriber types in "Where?" (portal spec §4.1): a place, an area
// code, an exchange, or a whole number they want (a vanity number). People
// write numbers every way: (717) 464-12345, 717.464.12345, +883 1 717 464
// 12345, with full-width digits from a phone keyboard. Everything here ends
// in the full form (+8831NPANXXSSSSS, src/core/numbers.ts) or a plain message.

export type Typed =
  | { kind: 'number'; number: string }
  | { kind: 'exchange'; exchange: string }
  | { kind: 'npa'; npa: string }
  | { kind: 'text'; text: string }
  | { kind: 'bad'; message: string };

export const TYPE_HINT = 'Type a place, an area code (717), an exchange (717-464) or a whole number (717-464-12345).';
export const MAX_TYPED = 64;

const PHONE_10 =
  'That looks like a 10-digit phone number. OpenCell numbers end in 5 digits, not 4: type the 11 digits after +883 1, like 717-464-12345.';
const NOT_883 = 'OpenCell numbers start with +883 1. Type the 11 digits after it, like 717-464-12345.';
const CODE_RULE = 'An area code and an exchange each start with 2 to 9 and never end in 11 (so not 1xx, 0xx or 911).';

export function parseTyped(s: string): Typed {
  const n = s.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (n.length > MAX_TYPED) return { kind: 'bad', message: `Please type something shorter (at most ${MAX_TYPED} characters).` };
  if (/\p{L}/u.test(n)) return { kind: 'text', text: n };
  // Dashes of every kind: what a phone keyboard or a pasted number has (‐ ‑ ‒ – — ―, the minus sign).
  const compact = n.replace(/[\s\-().\u2010-\u2015\u2212]/g, '');
  const m = /^(\+?)(\d{3,15})$/.exec(compact);
  if (!m) return { kind: 'bad', message: TYPE_HINT };
  const [, plus, d] = m;
  if (plus && !d.startsWith('8831')) return { kind: 'bad', message: NOT_883 };
  // The digits after +883 1: the whole number's 11, or an exchange's 6.
  const rest = d.startsWith('8831') && (plus || d.length === 15 || d.length === 14 || d.length === 10) ? d.slice(4) : d;
  switch (rest.length) {
    case 11:
      return isFullNumber(`+8831${rest}`) ? { kind: 'number', number: `+8831${rest}` } : { kind: 'bad', message: CODE_RULE };
    case 10:
      return { kind: 'bad', message: PHONE_10 };
    case 6:
      return isExchange(`+8831${rest}`) ? { kind: 'exchange', exchange: `+8831${rest}` } : { kind: 'bad', message: CODE_RULE };
    case 3:
      return /^[2-9]\d\d$/.test(rest) && !rest.endsWith('11') && rest !== '883' ? { kind: 'npa', npa: rest } : { kind: 'bad', message: CODE_RULE };
    default:
      return { kind: 'bad', message: TYPE_HINT };
  }
}
