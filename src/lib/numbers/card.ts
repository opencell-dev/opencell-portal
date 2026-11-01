import type { NumberRow } from './ownership';

// A number's card on My numbers (portal spec §5): its state in words.
// No server imports: the live card (a client component) uses it too.

export type Tone = 'wait' | 'ok' | 'warn' | 'off';
export interface CardState {
  label: string;
  tone: Tone;
}

/** A number not seen for this long says so (spec §5 "not seen for X"). */
export const NOT_SEEN_MS = 15 * 60_000;
export const RELEASED: CardState = { label: 'Released (not activated in 3 days)', tone: 'off' };

/** "2 d 4 h", "3 h 12 m", "5 m", "less than a minute": the card's short form. */
export function shortSpan(ms: number): string {
  if (ms < 60_000) return 'less than a minute';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m % 60} m`;
  return `${m} m`;
}

type CardRow = Pick<NumberRow, 'state' | 'disabled' | 'registered' | 'cellId' | 'lastSeenAt' | 'tokenExpiresAt'>;

/**
 * Waiting (with the time left), disabled, registered on a cell (by name, when
 * the core told us), not seen for a while, or activated.
 */
export function cardState(row: CardRow, now: number, cellName?: (id: number) => string | undefined): CardState {
  if (row.disabled) return { label: 'Disabled', tone: 'off' };
  if (row.state === 'unactivated') {
    const left = (row.tokenExpiresAt ?? 0) - now;
    return left > 0 ? { label: `Waiting for activation · ${shortSpan(left)} left`, tone: 'wait' } : RELEASED;
  }
  if (row.registered && row.cellId !== null) return { label: `Registered on cell ${cellName?.(row.cellId) ?? row.cellId}`, tone: 'ok' };
  if (row.lastSeenAt !== null && now - row.lastSeenAt > NOT_SEEN_MS) return { label: `Not seen for ${shortSpan(now - row.lastSeenAt)}`, tone: 'warn' };
  return { label: 'Activated', tone: 'ok' };
}
