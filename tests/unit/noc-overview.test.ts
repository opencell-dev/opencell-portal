import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DemoBanner } from '@/components/noc/demo-banner';
import { nocLinks } from '@/components/noc/noc-nav';
import { ActivityTiles, CallMix } from '@/components/noc/activity';
import { AttentionList, CoreTable, KpiTiles, NOT_REPORTED, NotReported } from '@/components/noc/overview';
import { type Activity, callStats, summarizeActivity } from '@/lib/noc/activity';
import { summarize } from '@/lib/noc/snapshot';
import { snap } from '../helpers/noc-fixture';

describe('the overview (NOC design §9.1)', () => {
  it('shows the totals, each core answering or Unreachable, and what needs attention', () => {
    const s = summarize(snap);
    const tiles = renderToStaticMarkup(createElement(KpiTiles, { s }));
    for (const t of ['Cores answering', '1 / 2', 'Cells online', '1 / 2', 'Terminals registered', '7', 'Calls now', '2', 'Subscribers', '12']) {
      expect(tiles).toContain(t);
    }
    // Review M5: core2 is Unreachable, so its cells are unknown — the cells
    // tile must say so, not read as "all accounted for".
    expect(tiles).toContain('cells unknown for some cores');
    const table = renderToStaticMarkup(createElement(CoreTable, { cores: snap.cores }));
    expect(table).toMatch(/core1.*Answering.*oc-core-1.*v0\.3\.1.*3 h 2 min.*1 \/ 2/s);
    expect(table).toMatch(/core2.*Unreachable/s);
    expect(table).toContain('href="/noc/cores/core2"');
    const att = renderToStaticMarkup(createElement(AttentionList, { items: s.attention }));
    expect(att).toMatch(/Critical.*core2 did not answer within 3 s.*Warning.*Cell 2 &quot;Lancaster 2&quot; on core1 offline \(last HELLO 20 min ago\)/s);
    expect(att).toContain('href="/noc/cells/core1/2"');
    expect(renderToStaticMarkup(createElement(AttentionList, { items: [] }))).toContain('Nothing needs attention.');
  });

  it('says what it cannot show yet, and why', () => {
    const out = renderToStaticMarkup(createElement(NotReported));
    expect(NOT_REPORTED.length).toBeGreaterThanOrEqual(4);
    for (const n of NOT_REPORTED) expect(out).toContain(n.why);
    expect(out).toContain('CALL_STATS');
    // Plan N2a reports these now: they are no longer "not reported".
    for (const op of ['cell.radio', 'reg.list', 'cdr.recent', 'audit.list', 'ocss.status', 'core.blocks']) expect(out).not.toContain(op);
  });

  it('labels the fake core, and nothing otherwise', () => {
    expect(renderToStaticMarkup(createElement(DemoBanner, { fake: true }))).toContain('Fake core: demo data, not the OpenCell network');
    expect(renderToStaticMarkup(createElement(DemoBanner, { fake: false }))).toBe('');
  });

  it('offers number lookup to any staff viewer (ruling 2026-10-01 #8/#9), and the demo only to an admin on the fake core', () => {
    expect(nocLinks(false, true).map((l) => l.href)).toEqual(['/noc', '/noc/cells', '/noc/topology', '/noc/lookup']);
    expect(nocLinks(true, false).map((l) => l.href)).toEqual(['/noc', '/noc/cells', '/noc/topology', '/noc/lookup']);
    expect(nocLinks(true, true).map((l) => l.href)).toContain('/noc/demo');
    expect(nocLinks(false, true).map((l) => l.href)).not.toContain('/noc/demo');
  });
});

describe('the overview: the last day (plan N2a)', () => {
  const stats = (o: Partial<ReturnType<typeof callStats>> = {}) => ({ ...callStats([], 0), ...o });
  const activity: Activity = {
    at: 0,
    cores: [
      {
        id: 'core1',
        calls: {
          state: 'ok',
          value: stats({
            total: 50,
            answered: 39,
            byResult: { answered: 39, no_answer: 5, busy: 3, unreachable: 2, failed: 1 },
            byCause: { 0: 40, 3: 5, 2: 3, 4: 2 },
            byLeg: { cell: 40, echo: 8, playback: 0, peer: 2 },
          }),
          complete: true,
        },
        registrations: { state: 'ok', value: { total: 120, byCell: { 1: 120 } }, complete: true },
      },
      { id: 'core2', calls: { state: 'unsupported' }, registrations: { state: 'unsupported' } },
    ],
  };

  it('adds up the cores that reported, and names the ones that did not', () => {
    expect(summarizeActivity(activity)).toMatchObject({ calls: { total: 50, answered: 39 }, registrations: 120, missing: ['core2'], catchingUp: false });
    expect(summarizeActivity({ at: 0, cores: [activity.cores[1]] })).toMatchObject({ calls: null, registrations: null });
  });

  it("shows the day's calls, how many were answered, the registrations, and the mix by result and cause", () => {
    const a = summarizeActivity(activity);
    const tiles = renderToStaticMarkup(createElement(KpiTiles, { s: summarize(snap) }, createElement(ActivityTiles, { a })));
    for (const t of ['Calls, last 24 h', '50', '78 % answered', 'not from core2', 'Registrations, last 24 h', '120']) expect(tiles).toContain(t);
    const mix = renderToStaticMarkup(createElement(CallMix, { s: a.calls }));
    expect(mix).toMatch(/answered.*39.*78 %.*no answer.*5.*10 %/s);
    expect(mix).toMatch(/normal.*\(0\).*40.*no answer.*\(3\).*5/s);
    expect(mix).toContain('To the echo service 8, playback 0, another core 2');
    expect(mix).toContain('href="/noc/calls?result=busy"');
    expect(renderToStaticMarkup(createElement(CallMix, { s: null }))).toContain('No core reported its calls');
    expect(renderToStaticMarkup(createElement(ActivityTiles, { a: summarizeActivity({ at: 0, cores: [activity.cores[1]] }) }))).toContain(
      'not reported by the cores',
    );
  });
});
