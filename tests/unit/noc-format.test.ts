import { describe, expect, it } from 'vitest';
import { ago, duration, exact, groupNumber, modeLabel, shortFpr } from '@/lib/noc/format';

describe('NOC formatting (NOC design §9)', () => {
  const now = 1_790_000_000_000;

  it('writes relative times', () => {
    expect(ago(now, now)).toBe('just now');
    expect(ago(now - 42_000, now)).toBe('42 s ago');
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(ago(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(ago(now - 2 * 86400_000, now)).toBe('2 d ago');
    expect(ago(now + 60_000, now)).toBe('in the future');
  });

  it('writes the exact time in UTC', () => {
    expect(exact(Date.UTC(2026, 9, 1, 4, 12, 9))).toBe('2026-10-01 04:12:09 UTC');
  });

  it('writes durations', () => {
    expect(duration(42)).toBe('42 s');
    expect(duration(300)).toBe('5 min');
    expect(duration(3 * 3600 + 12 * 60)).toBe('3 h 12 min');
    expect(duration(4 * 86400 + 3 * 3600)).toBe('4 d 3 h');
    expect(duration(-5)).toBe('0 s');
  });

  it('shortens fingerprints and names modes', () => {
    expect(shortFpr(`ab12cd34${'0'.repeat(52)}9f0e`)).toBe('ab12cd34…9f0e');
    expect(shortFpr('abc')).toBe('abc');
    expect(modeLabel('part15')).toBe('Part 15');
    expect(modeLabel('part97')).toBe('Part 97');
  });

  it('groups a full number in the display form, and leaves anything else alone', () => {
    expect(groupNumber('+883171746412345')).toBe('+883-1-717-464-12345');
    expect(groupNumber('+12025550100')).toBe('+12025550100');
  });
});
