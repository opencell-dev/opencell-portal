import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { exchanges, npas } from '@/db/schema';
import { setNpaOverride } from '@/lib/numbers/homing';
import { applyNanpa, readNanpaDir } from '@/lib/numbers/nanpa-refresh';
import { exchangeOffered, exchangesOfPlace, searchPlaces } from '@/lib/numbers/places';
import { type TestCtx, testCtx } from '../helpers/ctx';

let ctx: TestCtx;
beforeAll(() => {
  ctx = testCtx();
  applyNanpa(ctx, readNanpaDir('tests/fixtures/nanpa'));
  // A withdrawn exchange, and a non-geographic NPA that somehow has a code.
  ctx.db.update(exchanges).set({ withdrawnAt: 1 }).where(eq(exchanges.npaNxx, '717397')).run();
  ctx.db.insert(exchanges).values({ npaNxx: '500200', npa: '500', nxx: '200', region: 'PA', rateCenter: 'LANCASTER', firstSeenAt: 1 }).run();
});

const labels = (q: string) => searchPlaces(ctx, q).map((p) => p.label);

describe('searchPlaces (spec §4.1 "Where?")', () => {
  it('finds a city by name, with its exchanges and side', () => {
    const [pa, ...rest] = searchPlaces(ctx, 'lancaster');
    expect(pa).toEqual({
      label: 'Lancaster, PA (717-291, +4 more)',
      region: 'PA',
      rateCenter: 'LANCASTER',
      exchanges: ['+8831717291', '+8831717295', '+8831717392', '+8831717393', '+8831717464'],
      side: 'east',
    });
    expect(rest.map((p) => p.label)).toEqual(['Lancaster, OH (220-207, +3 more)', 'Lancaster, CA (661-206)']);
  });

  it('filters by ", ST" and by prefix', () => {
    expect(labels('lancaster, oh')).toEqual(['Lancaster, OH (220-207, +3 more)']);
    expect(labels('LANC')).toHaveLength(3);
    expect(labels('wilkes')).toEqual(['Wilkes-Barre, PA (570-200)']); // by the pretty name: the code is WILKSBARRE
    expect(labels('montreal')).toEqual(['Montréal, QC (263-222, +1 more)']);
    expect(labels('Montréal')).toEqual(['Montréal, QC (263-222, +1 more)']);
    expect(labels("st. john's")).toEqual(["St John's, NL (709-207)"]);
    expect(labels('nowhere')).toEqual([]);
    expect(labels('100%')).toEqual([]); // LIKE wildcards are literal
  });

  it('a place without a Local Calling Guide name is title-cased from its code', () => {
    expect(labels('twin')).toEqual(['Twincities, MN (612-200, +1 more)']);
  });

  it('a region code or name lists its places by exchange count', () => {
    // Rush and Wilkes-Barre tie on count: the nearer to the first (Lancaster) comes first (P2 decision 6).
    expect(labels('PA')).toEqual(['Lancaster, PA (717-291, +4 more)', 'York, PA (717-843, +3 more)', 'Wilkes-Barre, PA (570-200)', 'Rush, PA (570-201)']);
    expect(labels('Pennsylvania')).toEqual(labels('PA'));
    expect(labels('ontario')).toEqual(['Toronto, ON (416-200, +2 more)', 'Barrie, ON (249-612)']);
  });

  it('an area code lists its places; an exchange or a number finds its place', () => {
    expect(labels('717')).toEqual(['Lancaster, PA (717-291, +4 more)', 'York, PA (717-843, +3 more)']);
    const ex = searchPlaces(ctx, '717-464');
    expect(ex).toHaveLength(1);
    expect(ex[0].exchanges[0]).toBe('+8831717464'); // the one asked for first
    expect(searchPlaces(ctx, '717-464-12345')[0].rateCenter).toBe('LANCASTER');
  });

  it('never offers a withdrawn exchange or a non-geographic NPA', () => {
    const all = searchPlaces(ctx, 'lancaster', 50).flatMap((p) => p.exchanges);
    expect(all).not.toContain('+8831717397');
    expect(all).not.toContain('+8831500200');
    expect(searchPlaces(ctx, '717-397')).toEqual([]);
    expect(searchPlaces(ctx, '500')).toEqual([]);
    expect(exchangeOffered(ctx, '+8831717397')).toBeNull();
    expect(exchangeOffered(ctx, '+8831500200')).toBeNull();
    expect(exchangeOffered(ctx, '+8831717464')).toMatchObject({ region: 'PA', rateCenter: 'LANCASTER', side: 'east' });
  });

  it('an override moves the side', () => {
    setNpaOverride(ctx, '570', 'west', 1);
    expect(searchPlaces(ctx, 'rush')[0].side).toBe('west');
    setNpaOverride(ctx, '570', null, 1);
  });

  it('an NPA with no known region is never offered', () => {
    ctx.db.update(npas).set({ region: '' }).where(eq(npas.npa, '612')).run();
    expect(labels('twin')).toEqual([]);
    ctx.db.update(npas).set({ region: 'MN' }).where(eq(npas.npa, '612')).run();
  });

  it('exchangesOfPlace', () => {
    expect(exchangesOfPlace(ctx, 'PA', 'YORK')).toEqual(['+8831717843', '+8831717845', '+8831717846', '+8831717848']);
    expect(exchangesOfPlace(ctx, 'PA', 'NOWHERE')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(searchPlaces(ctx, 'PA', 2)).toHaveLength(2);
  });
});
