import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RadioPanel } from '@/components/noc/radio-panel';
import { TerminalTable } from '@/components/noc/terminal-table';
import { until } from '@/lib/noc/format';
import { tierFor } from '@/lib/noc/signal';
import { AT, fakeRadio } from '../helpers/noc-fixture';

// A cell's page (plan N2a): its radio health and its terminals' signal.

const ok = (o: Parameters<typeof fakeRadio>[0] = {}) => ({ state: 'ok' as const, value: [{ ...fakeRadio(o), cellId: 1 }] });
const html = (props: Parameters<typeof RadioPanel>[0]) => renderToStaticMarkup(createElement(RadioPanel, props));

describe('the radio panel', () => {
  it("shows a fresh report: PPS, timebase, temperature, anchor, uptime, when, and the board's counters", () => {
    const out = html({ radio: ok(), cellId: 1, online: true, now: AT });
    expect(out).toMatch(/Radio 0.*base-station board, band 0, firmware 0\.3\.0/s);
    expect(out).toMatch(/PPS \(GPS time\).*locked.*Timebase.*yes.*Temperature.*41 °C.*Anchor channel.*30.*Board up for.*1 h 0 min.*Reported.*20 s ago/s);
    expect(out).toMatch(/Schedules.*30000.*Schedule misses.*5.*Late slots.*7.*Radio errors.*1 \(last -2\).*ACK errors.*3 \(late 2\).*Terminals heard.*2/s);
    expect(out).not.toContain('role="alert"');
  });

  it('says a stale report or a silent board leaves PPS, time and temperature unknown', () => {
    const stale = html({ radio: ok({ reportedAt: AT - 6 * 60_000 }), cellId: 1, online: true, now: AT });
    expect(stale).toContain('This report is 6 min old');
    expect(stale).toMatch(/PPS \(GPS time\).*unknown.*Timebase.*unknown.*Temperature.*unknown/s);
    const silent = html({ radio: ok({ pps: 'unlocked', timebase: false, tempC: null }), cellId: 1, online: true, now: AT });
    expect(silent).toContain('its board is not answering');
  });

  it("tells an older core, a core that did not answer, a cell that has not reported and one that is not linked apart", () => {
    expect(html({ radio: { state: 'unsupported' }, cellId: 1, online: true, now: AT })).toContain('needs oc-core v0.4.0');
    expect(html({ radio: undefined, cellId: 1, online: true, now: AT })).toContain('needs oc-core v0.4.0');
    expect(html({ radio: { state: 'unreachable' }, cellId: 1, online: true, now: AT })).toContain('did not give its radio reports in time');
    expect(html({ radio: ok(), cellId: 2, online: true, now: AT })).toContain('has not reported its radio yet');
    expect(html({ radio: { state: 'ok', value: [] }, cellId: 2, online: false, now: AT })).toContain('Not linked');
  });
});

describe('the terminal table', () => {
  it("shows each terminal's number, TMID prefix, times, signal and the tier its SNR would carry", () => {
    const out = renderToStaticMarkup(
      createElement(TerminalTable, {
        core: 'core1',
        now: AT,
        rows: [
          { number: '+883171746412345', tmidPrefix: '76ad', cellId: 3, registeredAt: AT - 600_000, expiresAt: AT + 3000_000, rssiDbm: -61, snrDb: 9.5, heardAt: AT - 3000 },
          { number: '+883171746410777', tmidPrefix: '1122', cellId: 3, registeredAt: null, expiresAt: AT + 60_000, rssiDbm: null, snrDb: null, heardAt: null },
        ],
      }),
    );
    expect(out).toMatch(/\+883-1-717-464-12345.*76ad.*href="\/noc\/cells\/core1\/3".*10 min ago.*in 50 min.*-61 dBm.*9\.5 dB.*mid.*just now/s);
    expect(out).toMatch(/\+883-1-717-464-10777.*never.*in 1 min.*—.*—.*not heard.*never/s);
    expect(renderToStaticMarkup(createElement(TerminalTable, { core: 'c', now: AT, rows: [] }))).toContain('No terminals registered.');
  });

  it('estimates the tier from the SNR: near ≥ 10 dB, mid ≥ -2.5, edge ≥ -7.5', () => {
    expect([12, 10, 9.75, -2.5, -2.75, -7.5, -8, null].map(tierFor)).toEqual(['near', 'near', 'mid', 'mid', 'edge', 'edge', 'below edge', null]);
  });

  it('writes a time to come', () => {
    expect([AT + 42_000, AT + 5 * 60_000, AT + 3 * 3600_000, AT + 2 * 86400_000, AT - 1000].map((t) => until(t, AT))).toEqual([
      'in 42 s',
      'in 5 min',
      'in 3 h',
      'in 2 d',
      'passed',
    ]);
  });
});
