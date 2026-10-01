import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DemoBanner } from '@/components/noc/demo-banner';
import { nocLinks } from '@/components/noc/noc-nav';
import { AttentionList, CoreTable, KpiTiles, NOT_REPORTED, NotReported } from '@/components/noc/overview';
import { summarize } from '@/lib/noc/snapshot';
import { snap } from '../helpers/noc-fixture';

describe('the overview (NOC design §9.1)', () => {
  it('shows the totals, each core answering or Unreachable, and what needs attention', () => {
    const s = summarize(snap);
    const tiles = renderToStaticMarkup(createElement(KpiTiles, { s }));
    for (const t of ['Cores answering', '1 / 2', 'Cells online', '1 / 2', 'Terminals registered', '7', 'Calls now', '2', 'Subscribers', '12']) {
      expect(tiles).toContain(t);
    }
    const table = renderToStaticMarkup(createElement(CoreTable, { cores: snap.cores }));
    expect(table).toMatch(/core1.*Answering.*oc-core-1.*v0\.3\.1.*3 h 2 min.*1 \/ 2/s);
    expect(table).toMatch(/core2.*Unreachable/s);
    expect(table).toContain('href="/noc/cores/core2"');
    const att = renderToStaticMarkup(createElement(AttentionList, { items: s.attention }));
    expect(att).toMatch(/Critical.*core2 did not answer within 3 s.*Warning.*Cell 2 &quot;Lancaster 2&quot; on core1 offline for 20 min/s);
    expect(att).toContain('href="/noc/cells/core1/2"');
    expect(renderToStaticMarkup(createElement(AttentionList, { items: [] }))).toContain('Nothing needs attention.');
  });

  it('says what it cannot show yet, and why', () => {
    const out = renderToStaticMarkup(createElement(NotReported));
    expect(NOT_REPORTED.length).toBeGreaterThanOrEqual(6);
    for (const n of NOT_REPORTED) expect(out).toContain(n.why);
    expect(out).toContain('needs cdr.recent');
  });

  it('labels the fake core, and nothing otherwise', () => {
    expect(renderToStaticMarkup(createElement(DemoBanner, { fake: true }))).toContain('Fake core: demo data, not the OpenCell network');
    expect(renderToStaticMarkup(createElement(DemoBanner, { fake: false }))).toBe('');
  });

  it('offers the admin-only sections to an admin only, and the demo only on the fake core', () => {
    expect(nocLinks(false, true).map((l) => l.href)).toEqual(['/noc', '/noc/cells', '/noc/topology']);
    expect(nocLinks(true, false).map((l) => l.href)).toEqual(['/noc', '/noc/cells', '/noc/topology', '/noc/lookup']);
    expect(nocLinks(true, true).map((l) => l.href)).toContain('/noc/demo');
  });
});
