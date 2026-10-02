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
});
