// How the subscriber pages write numbers and times (portal spec §4.1, §5).
// No imports: client components use it too.

/** "+883 1 717 464 12345": the confirm step's grouping. Anything else as it is. */
export function spacedNumber(n: string): string {
  const m = /^\+883(1)(\d{3})(\d{3})(\d{5})$/.exec(n);
  return m ? `+883 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : n;
}

/** "717-464": an exchange (+8831NPANXX) as people say it. */
export function exchangeLabel(exchange: string): string {
  const m = /^\+8831(\d{3})(\d{3})$/.exec(exchange);
  return m ? `${m[1]}-${m[2]}` : exchange;
}

/** Time left, "2 d 23 h 59 m" (spec §4.1 step 4), down to "less than a minute", then "expired". */
export function countdown(ms: number): string {
  if (ms <= 0) return 'expired';
  if (ms < 60_000) return 'less than a minute';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d > 0) return `${d} d ${h} h ${min} m`;
  if (h > 0) return `${h} h ${min} m`;
  return `${min} m`;
}

/** "2026-11-04 12:00 UTC". */
export function utcMinute(t: number): string {
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A route segment as the number or exchange it names: Next may hand it over percent-encoded (%2B for +) or not. */
export function fromSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Where an exchange's shortlist is (step 2), and a number's confirm step (step 3). */
export const shortlistHref = (exchange: string) => `/numbers/new/${encodeURIComponent(exchange)}`;
export const confirmHref = (number: string) => `/numbers/new/confirm?number=${encodeURIComponent(number)}`;
export const activateHref = (number: string) => `/numbers/${encodeURIComponent(number)}/activate`;

/**
 * At most `n` of a long list, from `offset` and round to its start, and where
 * the next look starts (null when all of it fits). One rate center can have
 * thousands of exchanges (a New York one has 2,215), and a page must not list them all.
 */
export function otherWindow<T>(list: T[], offset: number, n: number): { shown: T[]; next: number | null } {
  if (list.length <= n) return { shown: list, next: null };
  const start = Number.isInteger(offset) && offset > 0 ? offset % list.length : 0;
  const shown = Array.from({ length: n }, (_, i) => list[(start + i) % list.length]);
  return { shown, next: (start + n) % list.length };
}
