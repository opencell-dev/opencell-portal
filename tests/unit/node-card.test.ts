import { describe, expect, it } from 'vitest';
import { cardLine, type NodeCard } from '@/lib/nodes/my-nodes';

const NOW = 1_790_000_000_000;
const MIN = 60_000;
const base: NodeCard = {
  id: 1,
  siteName: 'Roof',
  cellId: 7,
  coreId: 'core1',
  state: 'online',
  onlineSince: NOW - 3 * 86_400_000 - 4 * 3_600_000,
  offlineSince: null,
  lastHeardAt: NOW,
  boardUptimeS: null,
  terminals: 2,
  calls: 1,
  channel: { anchor: 30, mhz: 917.25, reported: true },
  mode: 'part15',
  cert: { fpr: 'a'.repeat(64), expiresAt: NOW + 86_400_000 },
  setup: null,
  alertsMuted: false,
  downtime: [],
  agreementBehind: false,
};

describe('cardLine', () => {
  it('says online and for how long', () => {
    expect(cardLine(base, NOW)).toEqual({ label: 'Online · up 3 d 4 h', tone: 'ok' });
  });

  it('falls back on the board’s uptime', () => {
    expect(cardLine({ ...base, onlineSince: null, boardUptimeS: 3600 }, NOW)).toEqual({ label: 'Online · up 1 h 0 min', tone: 'ok' });
    expect(cardLine({ ...base, onlineSince: null }, NOW)).toEqual({ label: 'Online', tone: 'ok' });
  });

  it('says offline and for how long', () => {
    expect(cardLine({ ...base, state: 'offline', onlineSince: null, offlineSince: NOW - 12 * MIN }, NOW)).toEqual({ label: 'Offline for 12 min', tone: 'off' });
    expect(cardLine({ ...base, state: 'offline', onlineSince: null, offlineSince: null, lastHeardAt: NOW - 3 * MIN }, NOW)).toEqual({ label: 'Offline for 3 min', tone: 'off' });
    expect(cardLine({ ...base, state: 'offline', offlineSince: null, lastHeardAt: null }, NOW)).toEqual({ label: 'Offline', tone: 'off' });
  });

  it('a downtime window takes the alarm out of offline', () => {
    const endsAt = Date.UTC(2026, 8, 21, 14, 0);
    const c: NodeCard = { ...base, state: 'offline', offlineSince: NOW - MIN, downtime: [{ id: 1, startsAt: NOW - MIN, endsAt: endsAt + 86_400_000, reason: 'Roof work' }] };
    const line = cardLine(c, NOW);
    expect(line.tone).toBe('wait');
    expect(line.label).toMatch(/^In downtime until \d\d:\d\d UTC/);
    // A window that has not begun changes nothing.
    expect(cardLine({ ...c, downtime: [{ id: 1, startsAt: NOW + MIN, endsAt: NOW + 2 * MIN, reason: 'Later' }] }, NOW).tone).toBe('off');
  });

  it('waits for setup, then for the node', () => {
    expect(cardLine({ ...base, state: 'waiting_setup', cert: null, onlineSince: null }, NOW)).toEqual({ label: 'Waiting for setup', tone: 'wait' });
    expect(cardLine({ ...base, state: 'waiting_setup', onlineSince: null }, NOW)).toEqual({ label: 'Waiting for the node', tone: 'wait' });
  });

  it('says when its core is not answering', () => {
    expect(cardLine({ ...base, state: 'unknown' }, NOW)).toEqual({ label: "Status unknown (core 1 didn't answer)", tone: 'warn' });
    expect(cardLine({ ...base, state: 'unknown', coreId: 'fake' }, NOW)).toEqual({ label: "Status unknown (fake didn't answer)", tone: 'warn' });
  });

  it('says revoked', () => {
    expect(cardLine({ ...base, state: 'revoked' }, NOW)).toEqual({ label: 'Revoked', tone: 'off' });
  });
});
