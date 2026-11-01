import { describe, expect, it } from 'vitest';
import { activationQrMail } from '@/lib/mail-templates';
import { countdown, otherWindow, spacedNumber } from '@/lib/numbers/format';
import { qrSvg } from '@/lib/qr';

describe('qrSvg', () => {
  it('draws an inline SVG and nothing that runs', async () => {
    const svg = await qrSvg('opencell:2:AAAA');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toMatch(/<script|on\w+=|javascript:|<foreignObject/i);
  });
});

describe('number display', () => {
  it('groups a number as the confirm step shows it', () => {
    expect(spacedNumber('+883171746412345')).toBe('+883 1 717 464 12345');
    expect(spacedNumber('nonsense')).toBe('nonsense');
  });

  it('counts down in days, hours and minutes (spec §4.1 step 4: the live 3-day countdown)', () => {
    expect(countdown(72 * 3600_000 - 1)).toBe('2 d 23 h 59 m');
    expect(countdown(2 * 86400_000 + 4 * 3600_000 + 30_000)).toBe('2 d 4 h 0 m');
    expect(countdown(5 * 60_000 + 1)).toBe('5 m');
    expect(countdown(30_000)).toBe('less than a minute');
    expect(countdown(0)).toBe('expired');
    expect(countdown(-5)).toBe('expired');
  });
});

describe('otherWindow ("Other exchange in this area" for a place with hundreds)', () => {
  const list = Array.from({ length: 30 }, (_, i) => String(i));
  it('shows at most n, and walks round the list', () => {
    expect(otherWindow(list, 0, 12)).toEqual({ shown: list.slice(0, 12), next: 12 });
    expect(otherWindow(list, 24, 12)).toEqual({ shown: [...list.slice(24), ...list.slice(0, 6)], next: 6 });
    expect(otherWindow(list.slice(0, 5), 3, 12)).toEqual({ shown: list.slice(0, 5), next: null });
    expect(otherWindow([], 3, 12)).toEqual({ shown: [], next: null });
    expect(otherWindow(list, -9, 12).shown).toEqual(list.slice(0, 12));
    expect(otherWindow(list, Number.NaN, 12).shown).toEqual(list.slice(0, 12));
  });
});

describe('activationQrMail', () => {
  it('carries the text form and how to use it, and says when it stops working', () => {
    const m = activationQrMail('Ada', '+883171746412345', 'opencell:2:AAAA', Date.UTC(2026, 10, 4, 12, 0), 'https://portal.test');
    expect(m.subject).toBe('Your OpenCell activation code for +883 1 717 464 12345');
    expect(m.text).toContain('opencell:2:AAAA');
    expect(m.text).toContain('2026-11-04 12:00 UTC');
    expect(m.text).toContain('https://portal.test');
    expect(m.text).toMatch(/Hello Ada/);
  });
});
