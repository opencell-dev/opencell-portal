import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { exchanges, npas } from '@/db/schema';
import { applyNanpa, readNanpaDir } from '@/lib/numbers/nanpa-refresh';
import { exchangeOffered, exchangesOfPlace, searchPlaces, whyNotOffered } from '@/lib/numbers/places';
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

  it('an NPA assigned but not in service is never offered (OCSS spec §12 decision 11)', () => {
    ctx.db.update(npas).set({ inService: false }).where(eq(npas.npa, '570')).run();
    expect(labels('wilkes')).toEqual([]);
    expect(searchPlaces(ctx, '570')).toEqual([]);
    expect(exchangeOffered(ctx, '+8831570200')).toBeNull();
    expect(whyNotOffered(ctx, '+8831570200')).toBe("Numbers in area code 570 aren't offered yet.");
    ctx.db.update(npas).set({ inService: true }).where(eq(npas.npa, '570')).run();
    expect(labels('wilkes')).toEqual(['Wilkes-Barre, PA (570-200)']);
  });

  it('an NPA with no known region is never offered', () => {
    ctx.db.update(npas).set({ region: '' }).where(eq(npas.npa, '612')).run();
    expect(labels('twin')).toEqual([]);
    ctx.db.update(npas).set({ region: 'MN' }).where(eq(npas.npa, '612')).run();
  });

  it('natural queries: no comma, hyphens as spaces, a state name that is also a city', () => {
    expect(labels('Lancaster PA')).toEqual(['Lancaster, PA (717-291, +4 more)']);
    expect(labels('wilkes barre')).toEqual(['Wilkes-Barre, PA (570-200)']);
    expect(labels('wilkes-barre')).toEqual(['Wilkes-Barre, PA (570-200)']);
    expect(labels('york')).toEqual(['York, PA (717-843, +3 more)']);
    expect(labels('l')).toEqual([]); // one letter is not a search
    // A city named like a region: both, the city first.
    ctx.db.insert(exchanges).values({ npaNxx: '717999', npa: '717', nxx: '999', region: 'PA', rateCenter: 'OHIO', firstSeenAt: 1 }).run();
    const ohio = labels('ohio');
    expect(ohio[0]).toBe('Ohio, PA (717-999)');
    expect(ohio).toContain('Lancaster, OH (220-207, +3 more)');
    ctx.db.delete(exchanges).where(eq(exchanges.npaNxx, '717999')).run();
  });

  it('exchangesOfPlace', () => {
    expect(exchangesOfPlace(ctx, 'PA', 'YORK')).toEqual(['+8831717843', '+8831717845', '+8831717846', '+8831717848']);
    expect(exchangesOfPlace(ctx, 'PA', 'NOWHERE')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(searchPlaces(ctx, 'PA', 2)).toHaveLength(2);
  });
});

// KY is Kentucky and the Cayman Islands, MS Mississippi and Montserrat (OCSS spec §3.3).
// Checked on 2026-11-01: NANPA's utilized CO-code file and CNAC's hold no exchange in 345
// or 664, nor in any other Caribbean country's NPA (only US territories: 340, 787, 939), so
// neither country is ever offered today. If one ever came, this is what must hold.
describe('a region code that is also a country', () => {
  let c: TestCtx;
  beforeAll(() => {
    c = testCtx();
    const row = (npaNxx: string, region: string, rateCenter: string) => ({ npaNxx, npa: npaNxx.slice(0, 3), nxx: npaNxx.slice(3), region, rateCenter, firstSeenAt: 1 });
    c.db
      .insert(npas)
      .values([
        { npa: '606', region: 'KY', stateCode: 'US-KY', geographic: true, inService: true, updatedAt: 1 },
        { npa: '345', region: 'KY', stateCode: 'KY', geographic: true, inService: true, updatedAt: 1 },
        { npa: '228', region: 'MS', stateCode: 'US-MS', geographic: true, inService: true, updatedAt: 1 },
        { npa: '664', region: 'MS', stateCode: 'MS', geographic: true, inService: true, updatedAt: 1 },
      ])
      .run();
    c.db.insert(exchanges).values([row('606464', 'KY', 'PIKEVILLE'), row('345222', 'KY', 'GEORGE TOWN'), row('228222', 'MS', 'BILOXI'), row('664222', 'MS', 'BRADES')]).run();
  });
  const places = (q: string) => searchPlaces(c, q).map((p) => p.rateCenter);

  it('the code and the state name mean the state, not the country', () => {
    expect(places('KY')).toEqual(['PIKEVILLE']);
    expect(places('Kentucky')).toEqual(['PIKEVILLE']);
    expect(places('MS')).toEqual(['BILOXI']);
    expect(places('Mississippi')).toEqual(['BILOXI']);
  });

  it('the name means the country', () => {
    expect(places('Cayman Islands')).toEqual(['GEORGE TOWN']);
    expect(places('Montserrat')).toEqual(['BRADES']);
  });

  it('its own area code and place still find it', () => {
    expect(places('345')).toEqual(['GEORGE TOWN']);
    expect(places('george town')).toEqual(['GEORGE TOWN']);
  });
});
