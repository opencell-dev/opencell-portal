import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CellTable } from '@/components/noc/cell-table';
import { cellState, filterCells, parseCellFilter } from '@/lib/noc/cell-filter';
import { allCells } from '@/lib/noc/snapshot';
import { AT, cell, snap } from '../helpers/noc-fixture';

describe('the cell list (NOC design §9.4)', () => {
  const cells = allCells(snap);

  it('shows each cell with its core, state, last heard, mode, list, terminals, calls and a short fingerprint', () => {
    const out = renderToStaticMarkup(createElement(CellTable, { cells, now: AT }));
    expect(out).toMatch(/core1.*1.*Lancaster 1.*Online.*30 s ago.*Part 15.*7.*1.*ab12cd34…9f0e/s);
    expect(out).toMatch(/Lancaster 2.*Offline.*20 min ago.*Part 97/s);
    expect(out).toContain('title="2026-09-21');
    expect(out).toContain('href="/noc/cells/core1/2"');
    expect(renderToStaticMarkup(createElement(CellTable, { cells: [], now: AT }))).toContain('No cells match.');
  });

  it('shows a revoked cell without counts and a cell without a certificate as such', () => {
    const out = renderToStaticMarkup(
      createElement(CellTable, { cells: [{ ...cell({ revoked: true, online: false, certFpr: null }), core: 'core1' }], now: AT }),
    );
    expect(out).toContain('Revoked');
    expect(out).toContain('none pinned');
    expect(out).not.toMatch(/>7</);
  });

  it('filters by the URL, ignoring what does not parse', () => {
    expect(parseCellFilter({ core: 'core1', state: 'offline', mode: 'part97', q: ' Lan ' })).toEqual({
      core: 'core1',
      state: 'offline',
      mode: 'part97',
      q: 'Lan',
    });
    expect(parseCellFilter({ core: 'CORE 1;drop', state: 'weird', mode: ['part15', 'part97'], q: 'x'.repeat(99) })).toEqual({
      core: undefined,
      state: undefined,
      mode: 'part15',
      q: undefined,
    });
    expect(filterCells(cells, { state: 'offline' }).map((c) => c.cellId)).toEqual([2]);
    expect(filterCells(cells, { q: 'lancaster 1' }).map((c) => c.cellId)).toEqual([1]);
    expect(filterCells(cells, { q: '2' }).map((c) => c.cellId)).toEqual([2]);
    expect(filterCells(cells, { core: 'core2' })).toEqual([]);
    expect(cellState({ ...cell({ online: false, lastHeardAt: null }), core: 'x' })).toBe('never');
  });
});
