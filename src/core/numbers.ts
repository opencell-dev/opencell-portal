// OpenCell numbers in full form: +883 1 NPA NXX SSSSS (numbering-plan.md;
// network-core spec §7.11). The portal only ever handles the full form.

const FULL = /^\+8831[2-9]\d{2}[2-9]\d{2}\d{5}$/;
const EXCHANGE = /^\+8831[2-9]\d{2}[2-9]\d{2}$/;

export function isFullNumber(s: string): boolean {
  return FULL.test(s);
}

/** An exchange is the number's first part: +8831 NPA NXX. */
export function isExchange(s: string): boolean {
  return EXCHANGE.test(s);
}

export function exchangeOf(number: string): string {
  return number.slice(0, 11);
}

/** Assignable station numbers: 01000–99998, not 09911 (numbering-plan.md). */
export function isAssignable(number: string): boolean {
  if (!isFullNumber(number)) return false;
  const station = number.slice(-5);
  const n = Number(station);
  return n >= 1000 && n <= 99998 && station !== '09911';
}

/** The 8-byte BCD form: digits high nibble first, then 0xF (numbering v2 §4.1). */
export function numberBcd(number: string): Uint8Array {
  const digits = number.replace(/^\+/, '');
  const out = new Uint8Array(8).fill(0xff);
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(i) - 48;
    const byte = i >> 1;
    out[byte] = i % 2 === 0 ? (d << 4) | 0x0f : (out[byte] & 0xf0) | d;
  }
  return out;
}
