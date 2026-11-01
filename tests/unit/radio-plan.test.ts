import { describe, expect, it } from 'vitest';
import { FakeCore } from '@/core/fake';
import type { CoreHandle } from '@/core/types';
import { nodes } from '@/db/schema';
import { anchorMhz, certCn, cellName, channelLabel, newCellSeed, pickAnchor } from '@/lib/nodes/radio-plan';
import { cellCoreFor } from '@/lib/nodes/route';
import { testCtx, type TestCtx } from '../helpers/ctx';

const handle = (coreNo: number, cellAddr?: string): CoreHandle => ({ id: `core${coreNo}`, where: 'x', coreNo, core: new FakeCore(), ...(cellAddr ? { cellAddr } : {}) });

function nodeOn(ctx: TestCtx, anchor: number, cellId: number, revokedAt: number | null = null) {
  ctx.db.insert(nodes).values({ requestId: 1, coreId: 'fake', cellId, cellName: 'a', certCn: 'x', siteName: 'A', lat: 39, lon: -77, region: 'MD', contactPhone: 'x', anchor, cellSeed: 1, boardRole: 'bs', mode: 'part15', listGroup: 0, createdAt: 1, revokedAt }).run();
}

describe('anchors and frequencies', () => {
  it('maps an anchor to MHz', () => {
    expect(anchorMhz(30)).toBe(917.25);
    expect(anchorMhz(0)).toBe(902.25);
    expect(anchorMhz(51)).toBe(927.75);
    expect(anchorMhz(0, 2400)).toBe(2402);
    expect(anchorMhz(39, 2400)).toBe(2480);
  });

  it.each([[52, 915], [-1, 915], [1.5, 915], [40, 2400]] as const)('refuses anchor %d in band %d', (a, b) => {
    expect(() => anchorMhz(a, b)).toThrow();
  });

  it('labels a channel', () => {
    expect(channelLabel(30)).toBe('917.25 MHz, anchor 30');
    expect(channelLabel(0)).toBe('902.25 MHz, anchor 0');
  });

  it('picks the lowest anchor no unrevoked node uses', () => {
    const ctx = testCtx();
    expect(pickAnchor(ctx)).toBe(0);
    nodeOn(ctx, 0, 1);
    nodeOn(ctx, 1, 2);
    nodeOn(ctx, 3, 3);
    expect(pickAnchor(ctx)).toBe(2);
    nodeOn(ctx, 2, 4, 99);
    expect(pickAnchor(ctx)).toBe(2);
  });

  it('with every anchor used, picks the least used, lowest first', () => {
    const ctx = testCtx();
    for (let a = 0; a < 52; a++) nodeOn(ctx, a, a + 1);
    nodeOn(ctx, 0, 100);
    nodeOn(ctx, 1, 101);
    expect(pickAnchor(ctx)).toBe(2);
  });
});

describe('names', () => {
  it('makes a cell name of a site name', () => {
    expect(cellName('Frederick Roof #2!')).toBe('frederick-roof-2');
    expect(cellName('  --Ünïcode--  ')).toBe('n-code');
    expect(cellName('日本語')).toBe('node');
    const long = cellName(`${'a'.repeat(30)} b c`);
    expect(long.length).toBeLessThanOrEqual(31);
    expect(long).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  it('makes a certificate CN with the cell id', () => {
    expect(certCn(7, 'frederick-roof-2')).toBe('cell7-frederick-roof-2');
    expect(certCn(4294967295, 'a'.repeat(31))).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });

  it('makes a non-zero 32-bit seed', () => {
    for (let i = 0; i < 100; i++) {
      const s = newCellSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('cellCoreFor: a cell goes to its state side', () => {
  const ctxWith = (...cores: CoreHandle[]) => ({ ...testCtx(), cores });

  it('sends a western state to core 2 when it takes cells', () => {
    const r = cellCoreFor(ctxWith(handle(1, 'a:1'), handle(2, 'b:2')), 'CA');
    expect(r.handle.id).toBe('core2');
    expect(r.side).toBe('west');
    expect(r.note).toBeNull();
  });

  it('sends an eastern state to core 1', () => {
    const r = cellCoreFor(ctxWith(handle(1, 'a:1'), handle(2, 'b:2')), 'MD');
    expect(r).toMatchObject({ side: 'east', note: null });
    expect(r.handle.id).toBe('core1');
  });

  it('falls back to the first core with an address, and says so', () => {
    const r = cellCoreFor(ctxWith(handle(1, 'a:1'), handle(2)), 'CA');
    expect(r.handle.id).toBe('core1');
    expect(r.side).toBe('west');
    expect(r.note).toContain('core 2');
  });

  it('takes the admin’s pick when it has an address, and not when it has none', () => {
    const ctx = ctxWith(handle(1, 'a:1'), handle(2));
    expect(cellCoreFor(ctx, 'MD', 'core1').handle.id).toBe('core1');
    const west = ctxWith(handle(1, 'a:1'), handle(2, 'b:2'));
    expect(cellCoreFor(west, 'MD', 'core2')).toMatchObject({ note: null });
    expect(cellCoreFor(west, 'MD', 'core2').handle.id).toBe('core2');
    expect(cellCoreFor(ctx, 'CA', 'core2').handle.id).toBe('core1');
    expect(cellCoreFor(ctx, 'CA', 'nope').handle.id).toBe('core1');
  });

  it('throws when no core takes cells', () => {
    expect(() => cellCoreFor(ctxWith(handle(1), handle(2)), 'MD')).toThrow('No core takes cells');
  });

  it('a single core takes everything, with nothing to say', () => {
    expect(cellCoreFor(ctxWith(handle(1, 'a:1')), 'CA')).toMatchObject({ note: null });
  });
});
