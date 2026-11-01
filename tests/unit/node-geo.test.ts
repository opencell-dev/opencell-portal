import { describe, expect, it } from 'vitest';
import { nodes, rateCenters } from '@/db/schema';
import { haversineKm, nearestNode, nearestRateCenter, pinSchema, roundPublic } from '@/lib/nodes/geo';
import { testCtx, type TestCtx } from '../helpers/ctx';

function addNode(ctx: TestCtx, over: Partial<typeof nodes.$inferInsert> = {}) {
  return ctx.db
    .insert(nodes)
    .values({ requestId: 1, coreId: 'fake', cellId: 1, cellName: 'a', certCn: 'cell1-a', siteName: 'A', lat: 39, lon: -77, region: 'MD', contactPhone: '+13015550100', anchor: 0, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1, ...over })
    .returning()
    .get();
}

describe('rounding a pin for the public', () => {
  it('rounds to two decimals', () => {
    expect(roundPublic(39.41437, -77.41054)).toEqual({ lat: 39.41, lon: -77.41 });
    expect(roundPublic(40, -100)).toEqual({ lat: 40, lon: -100 });
  });

  it('moves a pin by at most half a step, and never leaves more than two decimals', () => {
    for (let i = 0; i < 2000; i++) {
      const lat = 14 + (i * 58) / 2000 + i * 1e-5;
      const lon = -180 + (i * 130) / 2000 + i * 1e-5;
      const r = roundPublic(lat, lon);
      expect(Math.abs(r.lat - lat)).toBeLessThanOrEqual(0.0050001);
      expect(Math.abs(r.lon - lon)).toBeLessThanOrEqual(0.0050001);
      expect(String(r.lat)).toMatch(/^-?\d+(\.\d{1,2})?$/);
      expect(String(r.lon)).toMatch(/^-?\d+(\.\d{1,2})?$/);
    }
  });
});

describe('pinSchema', () => {
  it('takes numbers or form strings in the NANP area, to 6 decimals', () => {
    expect(pinSchema.parse({ lat: '39.41437123', lon: '-77.41054987' })).toEqual({ lat: 39.414371, lon: -77.41055 });
    expect(pinSchema.parse({ lat: 14, lon: -180 })).toEqual({ lat: 14, lon: -180 });
  });

  it.each([
    [10, 0],
    [13.99, -77],
    [72.01, -77],
    [39, -49.9],
    [39, -180.1],
    [Number.NaN, -77],
    [39, Number.POSITIVE_INFINITY],
    ['', ''],
    ['abc', '-77'],
  ])('refuses %j, %j', (lat, lon) => {
    expect(pinSchema.safeParse({ lat, lon }).success).toBe(false);
  });
});

describe('distances', () => {
  it('measures great circles', () => {
    expect(haversineKm({ lat: 39, lon: -77 }, { lat: 39, lon: -77 })).toBe(0);
    expect(haversineKm({ lat: 0, lon: -90 }, { lat: 1, lon: -90 })).toBeCloseTo(111.19, 1);
  });

  it('finds the nearest unrevoked node, leaving one out if asked', () => {
    const ctx = testCtx();
    const a = addNode(ctx, { cellId: 1, lat: 39, lon: -77, cellName: 'a' });
    const b = addNode(ctx, { cellId: 2, lat: 40, lon: -77, cellName: 'b' });
    addNode(ctx, { cellId: 3, lat: 39.001, lon: -77, cellName: 'gone', revokedAt: 5 });
    expect(nearestNode(ctx, { lat: 39.01, lon: -77 })).toMatchObject({ nodeId: a.id, cellName: 'a' });
    expect(nearestNode(ctx, { lat: 39.01, lon: -77 }, a.id)).toMatchObject({ nodeId: b.id, cellName: 'b' });
    expect(nearestNode(testCtx(), { lat: 39, lon: -77 })).toBeNull();
  });

  it('finds the nearest rate center, widening past the first box, and none in an empty table', () => {
    const ctx = testCtx();
    expect(nearestRateCenter(ctx, { lat: 39, lon: -77 })).toBeNull();
    ctx.db.insert(rateCenters).values([
      { region: 'PA', name: 'LANCASTER', display: 'Lancaster', lat: 40.04, lon: -76.3 },
      { region: 'TX', name: 'DALLAS', display: 'Dallas', lat: 32.78, lon: -96.8 },
      { region: 'PA', name: 'NOPLACE', display: 'Noplace', lat: null, lon: null },
    ]).run();
    expect(nearestRateCenter(ctx, { lat: 39.8, lon: -76.5 })).toMatchObject({ region: 'PA', name: 'Lancaster' });
    // Nothing within 1.5 degrees: the full scan.
    expect(nearestRateCenter(ctx, { lat: 25, lon: -100 })).toMatchObject({ region: 'TX', name: 'Dallas' });
  });
});
