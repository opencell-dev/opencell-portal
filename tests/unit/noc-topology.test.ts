import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Topology } from '@/components/noc/topology';
import type { NetworkSnapshot } from '@/lib/noc/snapshot';
import { CELLS_PER_ROW, cut, layoutTopology } from '@/lib/noc/topology';
import { cell, snap, st } from '../helpers/noc-fixture';

describe('the topology (NOC design §9.2)', () => {
  it('puts cores in a row and each core’s cells beneath it, with a backhaul edge per cell and OCSS between cores', () => {
    const t = layoutTopology(snap);
    expect(t.cores.map((c) => [c.id, c.state])).toEqual([
      ['core1', 'ok'],
      ['core2', 'bad'],
    ]);
    expect(t.cells.map((c) => [c.core, c.cellId, c.state])).toEqual([
      ['core1', 1, 'ok'],
      ['core1', 2, 'warn'],
    ]);
    expect(t.edges.filter((e) => e.kind === 'backhaul')).toHaveLength(2);
    const ocss = t.edges.filter((e) => e.kind === 'ocss');
    expect(ocss).toHaveLength(1);
    expect(ocss[0]).toMatchObject({ state: 'off', title: expect.stringContaining('not reported') });
    expect(t.cells.every((c) => c.y > t.cores[0].y)).toBe(true);
  });

  it('wraps a core’s cells into rows and grows the drawing to fit', () => {
    const many: NetworkSnapshot = {
      ...snap,
      cores: [{ id: 'core1', where: 'x', status: st({}), cells: Array.from({ length: 9 }, (_, i) => cell({ cellId: i + 1 })) }],
    };
    const t = layoutTopology(many);
    expect(new Set(t.cells.map((c) => c.y)).size).toBe(Math.ceil(9 / CELLS_PER_ROW));
    expect(t.height).toBeGreaterThan(layoutTopology(snap).height);
    expect(cut('Harrisburg North Ridge 1')).toBe('Harrisburg No…');
  });

  it('draws an SVG with links and labels, and no style attribute (the CSP has no unsafe-inline)', () => {
    const out = renderToStaticMarkup(createElement(Topology, { t: layoutTopology(snap) }));
    expect(out).toContain('<svg');
    expect(out).toContain('href="/noc/cells/core1/1"');
    expect(out).toContain('href="/noc/cores/core2"');
    expect(out).toContain('core2 · Unreachable');
    expect(out).toContain('Lancaster 1');
    expect(out).not.toContain('style=');
  });

  describe('OCSS and blocks (plan N2a)', () => {
    const peer = (coreId: number, state: 'up' | 'connecting' | 'down', dials: boolean) => ({
      coreId,
      dials,
      state,
      since: 0,
      lastRxAt: null,
      lastTxAt: null,
      calls: 0,
      dropped: 0,
      address: dials ? 'x:7443' : null,
    });
    const core = (n: number, peers: ReturnType<typeof peer>[] | null) => ({
      id: `core${n}`,
      where: 'x',
      status: st({ coreId: n }),
      cells: [],
      ...(peers === null ? {} : { ocss: { state: 'ok' as const, value: peers } }),
      blocks: { state: 'ok' as const, value: [{ index: n, homeCore: n, role: 'home' as const, prefix: `88317${n}7` }] },
    });
    const ocss = (cores: ReturnType<typeof core>[]) => layoutTopology({ ...snap, cores }).edges.filter((e) => e.kind === 'ocss');

    it('draws the link as either side reports it, the worse of the two, and who dials', () => {
      expect(ocss([core(1, [peer(2, 'up', true)]), core(2, [peer(1, 'up', false)])])).toEqual([
        expect.objectContaining({ state: 'ok', title: 'OCSS core1 – core2: up / up (core1 dials)' }),
      ]);
      expect(ocss([core(1, [peer(2, 'up', true)]), core(2, [peer(1, 'connecting', false)])])[0].state).toBe('warn');
      expect(ocss([core(1, [peer(2, 'down', true)]), core(2, null)])[0]).toMatchObject({ state: 'bad', title: 'OCSS core1 – core2: down (core1 dials)' });
    });

    it('draws no edge between cores that both report and are not peers; arcs between cores that are not neighbours', () => {
      expect(ocss([core(1, []), core(2, [])])).toEqual([]);
      const three = ocss([core(1, [peer(3, 'up', true)]), core(2, []), core(3, [peer(1, 'up', false)])]);
      expect(three).toEqual([expect.objectContaining({ state: 'ok', bend: 40 })]);
      const out = renderToStaticMarkup(createElement(Topology, { t: layoutTopology({ ...snap, cores: [core(1, [peer(3, 'up', true)]), core(2, []), core(3, [peer(1, 'up', false)])] }) }));
      expect(out).toMatch(/<path d="M [\d.]+ 30 Q [\d.]+ 2 [\d.]+ 30"/);
      expect(out).not.toContain('style=');
    });

    it("names the block a core is home for under it", () => {
      const t = layoutTopology({ ...snap, cores: [core(1, [])] });
      expect(t.cores[0].sub).toBe('core1 · v0.3.1 · +8831717');
    });
  });
});
