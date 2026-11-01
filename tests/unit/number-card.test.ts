import { describe, expect, it } from 'vitest';
import { cardState, shortSpan } from '@/lib/numbers/card';

const NOW = 1_790_000_000_000;
const base = { state: 'activated' as const, disabled: false, registered: false, cellId: null, lastSeenAt: NOW - 60_000, tokenExpiresAt: null };
const names = (id: number) => (id === 3 ? 'Roof' : undefined);

describe('cardState (spec §5: waiting, activated, registered on cell "name", not seen for X)', () => {
  it.each([
    ['waiting, with the time left', { ...base, state: 'unactivated' as const, lastSeenAt: null, tokenExpiresAt: NOW + 2 * 86400_000 + 4 * 3600_000 + 59_000 }, 'Waiting for activation · 2 d 4 h left', 'wait'],
    ['waiting, the last minutes', { ...base, state: 'unactivated' as const, tokenExpiresAt: NOW + 5 * 60_000 }, 'Waiting for activation · 5 m left', 'wait'],
    ['waiting past its expiry: released', { ...base, state: 'unactivated' as const, tokenExpiresAt: NOW }, 'Released (not activated in 3 days)', 'off'],
    ['activated', base, 'Activated', 'ok'],
    ['activated, never seen', { ...base, lastSeenAt: null }, 'Activated', 'ok'],
    ['registered on a named cell', { ...base, registered: true, cellId: 3 }, 'Registered on cell Roof', 'ok'],
    ['registered on a cell the core did not name', { ...base, registered: true, cellId: 9 }, 'Registered on cell 9', 'ok'],
    ['not seen for a while', { ...base, lastSeenAt: NOW - 3 * 3600_000 - 12 * 60_000 }, 'Not seen for 3 h 12 m', 'warn'],
    ['not seen for exactly 15 minutes is still fine', { ...base, lastSeenAt: NOW - 15 * 60_000 }, 'Activated', 'ok'],
    ['disabled beats everything', { ...base, disabled: true, registered: true, cellId: 3 }, 'Disabled', 'off'],
  ])('%s', (_what, row, label, tone) => {
    expect(cardState(row, NOW, names)).toEqual({ label, tone });
  });

  it('shortSpan', () => {
    expect(shortSpan(30_000)).toBe('less than a minute');
    expect(shortSpan(16 * 60_000)).toBe('16 m');
    expect(shortSpan(3 * 86400_000)).toBe('3 d 0 h');
  });
});
