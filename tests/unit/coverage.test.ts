import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoverageMap } from '@/components/coverage-map';
import { BASEMAP } from '@/content/basemap';
import { nodes, nodeState, users } from '@/db/schema';
import { forgetPublicNodes, publicNodes } from '@/lib/coverage';
import { fitView, MAP_VIEWBOX, project } from '@/lib/map-projection';
import { testCtx, type TestCtx } from '../helpers/ctx';

const EXACT_LAT = 39.414371;
const EXACT_LON = -77.410541;

function addNode(ctx: TestCtx, over: Partial<typeof nodes.$inferInsert> = {}, online: boolean | null = true) {
  const n = ctx.db.insert(nodes).values({ requestId: 1, coreId: 'fake', cellId: Math.floor(Math.random() * 1e9), cellName: 'secret-site', certCn: 'x', siteName: '12 Secret Street', lat: EXACT_LAT, lon: EXACT_LON, region: 'MD', contactPhone: '+13015550100', anchor: 3, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1, certFpr: 'a'.repeat(64), ...over }).returning().get();
  ctx.db.insert(nodeState).values({ nodeId: n.id, online, checkedAt: 1 }).run();
  return n;
}

describe('publicNodes', () => {
  it('holds set-up, unrevoked nodes, rounded to 2 decimals, labelled by id and state', () => {
    const ctx = testCtx();
    const n = addNode(ctx);
    addNode(ctx, { certFpr: null }); // never set up
    addNode(ctx, { revokedAt: 5 }); // revoked
    const off = addNode(ctx, {}, false);
    const unknown = addNode(ctx, {}, null);
    const rows = publicNodes(ctx);
    expect(rows).toEqual([
      { label: `Node ${n.id}`, region: 'MD', lat: 39.41, lon: -77.41, online: true },
      { label: `Node ${off.id}`, region: 'MD', lat: 39.41, lon: -77.41, online: false },
      { label: `Node ${unknown.id}`, region: 'MD', lat: 39.41, lon: -77.41, online: null },
    ]);
    for (const r of rows) {
      expect(String(r.lat)).toMatch(/^-?\d+\.\d{1,2}$/);
      expect(String(r.lon)).toMatch(/^-?\d+\.\d{1,2}$/);
      expect(Object.keys(r).sort()).toEqual(['label', 'lat', 'lon', 'online', 'region']);
    }
  });

  it('never has an operator, a site name or a phone in it', () => {
    const ctx = testCtx();
    const u = ctx.db.insert(users).values({ name: 'Alice', email: 'alice@example.org', createdAt: 1 }).returning().get().id;
    addNode(ctx, { userId: u });
    const s = JSON.stringify(publicNodes(ctx));
    for (const leak of ['Alice', 'alice@', 'Secret', 'secret-site', '555', '414371', '410541']) expect(s).not.toContain(leak);
  });

  it('is kept 60 s', () => {
    const ctx = testCtx();
    addNode(ctx);
    expect(publicNodes(ctx)).toHaveLength(1);
    addNode(ctx);
    expect(publicNodes(ctx)).toHaveLength(1);
    ctx.clock.t += 60_000;
    expect(publicNodes(ctx)).toHaveLength(2);
    addNode(ctx);
    forgetPublicNodes(ctx);
    expect(publicNodes(ctx)).toHaveLength(3);
  });

  it('is empty on the NOC site', () => {
    const noc = testCtx({ OC_SITE: 'noc' });
    addNode(noc);
    expect(publicNodes(noc)).toEqual([]);
  });
});

describe('the view', () => {
  it('projects as the basemap was made', () => {
    expect(project(72, -170)).toEqual([0, 0]);
    expect(project(40, -100)[0]).toBeCloseTo(70 * BASEMAP.lonScale * 10, 2);
    expect(project(40, -100)[1]).toBe(320);
  });

  it('with no nodes, shows the contiguous US and southern Canada', () => {
    const [x, y, w, h] = fitView([]);
    const [left, top] = project(52, -126);
    const [right, bottom] = project(24, -64);
    expect(x).toBeCloseTo(left, 3);
    expect(y).toBeCloseTo(top, 3);
    expect(w).toBeCloseTo(right - left, 3);
    expect(h).toBeCloseTo(bottom - top, 3);
  });

  it('fits the nodes with 2 degrees around them', () => {
    const [x, y, w, h] = fitView([
      { lat: 30, lon: -100 },
      { lat: 40, lon: -80 },
    ]);
    const [left, top] = project(42, -102);
    const [right, bottom] = project(28, -78);
    expect(x).toBeCloseTo(left, 3);
    expect(y).toBeCloseTo(top, 3);
    expect(x + w).toBeCloseTo(right, 3);
    expect(y + h).toBeCloseTo(bottom, 3);
  });

  it('never shows less than 6 degrees', () => {
    const [x, y, w, h] = fitView([{ lat: 39, lon: -77 }]);
    expect(h).toBeCloseTo(60, 3);
    expect(w).toBeCloseTo(6 * BASEMAP.lonScale * 10, 2);
    const c = project(39, -77);
    expect(x + w / 2).toBeCloseTo(c[0], 2);
    expect(y + h / 2).toBeCloseTo(c[1], 2);
  });

  it('every region stays inside the whole map', () => {
    const [x, y, w, h] = MAP_VIEWBOX;
    for (const r of BASEMAP.regions) {
      for (const m of r.d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
        expect(Number(m[1])).toBeGreaterThanOrEqual(x);
        expect(Number(m[1])).toBeLessThanOrEqual(x + w);
        expect(Number(m[2])).toBeGreaterThanOrEqual(y);
        expect(Number(m[2])).toBeLessThanOrEqual(y + h);
      }
    }
  });
});

describe('the basemap', () => {
  it('holds the states and provinces, within its budget', () => {
    expect(BASEMAP.regions.length).toBeGreaterThanOrEqual(60);
    const codes = BASEMAP.regions.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['US-MD', 'US-CA', 'US-AK', 'US-HI', 'CA-ON', 'CA-BC']));
    expect(codes.filter((c) => !c.startsWith('US-') && !c.startsWith('CA-'))).toEqual([]);
    expect(JSON.stringify(BASEMAP).length).toBeLessThan(300 * 1024);
  });
});

describe('CoverageMap', () => {
  const row = (over = {}) => ({ label: 'Node 3', region: 'MD', lat: 39.41, lon: -77.41, online: true, ...over });

  it('is an SVG and a table of the same nodes, and no script', () => {
    const html = renderToStaticMarkup(CoverageMap({ nodes: [row(), row({ label: 'Node 4', online: false }), row({ label: 'Node 5', online: null })] }));
    expect(html).toContain('<svg');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Coverage map"');
    expect(html.match(/<title>/g)).toHaveLength(3);
    expect(html).toContain('<title>Node 3');
    expect(html).toContain('<table');
    expect(html).toContain('Node 4');
    expect(html).toContain('39.41, -77.41');
    expect(html).toContain('Online');
    expect(html).toContain('Offline');
    expect(html).toContain('Unknown');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('with no nodes says so', () => {
    const html = renderToStaticMarkup(CoverageMap({ nodes: [] }));
    expect(html).toContain('<svg');
    expect(html).not.toContain('<title>');
    expect(html).toContain('No base stations are listed yet');
  });

  it('never carries what a row has no business holding', () => {
    const html = renderToStaticMarkup(CoverageMap({ nodes: [row()] }));
    expect(html).not.toContain('414371');
  });
});
