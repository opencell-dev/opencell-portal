import { describe, expect, it } from 'vitest';
import { npas } from '@/db/schema';
import { listAudit } from '@/lib/audit';
import { setNpaOverride, sideLabel, sideOfNpa, sideOfRegion } from '@/lib/numbers/homing';
import { testCtx } from '../helpers/ctx';

// Portal spec §4.3, the table verbatim.
const EAST = [
  'ME', 'NH', 'VT', 'MA', 'RI', 'CT', 'NY', 'NJ', 'PA', 'DE', 'MD', 'VA', 'WV', 'NC', 'SC', 'GA', 'FL', 'AL', 'OH', 'MI', 'IN',
  'WI', 'IL', 'KY', 'TN', 'MS', 'DC', 'PR', 'VI', 'ON', 'QC', 'NB', 'NS', 'PE', 'NL',
  'AG', 'AI', 'BB', 'BM', 'BS', 'DM', 'DO', 'GD', 'JM', 'KN', 'KY', 'LC', 'MS', 'SX', 'TC', 'TT', 'VC', 'VG',
];
const WEST = [
  'WA', 'OR', 'CA', 'NV', 'ID', 'MT', 'WY', 'UT', 'AZ', 'NM', 'CO', 'ND', 'SD', 'NE', 'KS', 'OK', 'TX',
  'MN', 'IA', 'MO', 'AR', 'LA', 'AK', 'HI', 'GU', 'MP', 'AS', 'MB', 'SK', 'AB', 'BC', 'YT', 'NT', 'NU',
];

function withNpa(ctx: ReturnType<typeof testCtx>, npa: string, region: string, geographic = true) {
  ctx.db.insert(npas).values({ npa, region, geographic, inService: true, updatedAt: 1 }).run();
}

describe('the Mississippi split (spec §4.3)', () => {
  it.each(EAST)('%s → east', (r) => expect(sideOfRegion(r)).toBe('east'));
  it.each(WEST)('%s → west', (r) => expect(sideOfRegion(r)).toBe('west'));

  it('the straddling states and the edge cases', () => {
    expect(sideOfRegion('MN')).toBe('west');
    expect(sideOfRegion('LA')).toBe('west');
    expect(sideOfRegion('WI')).toBe('east');
    expect(sideOfRegion('DC')).toBe('east');
    expect(sideOfRegion('NU')).toBe('west');
    expect(sideOfRegion('JM')).toBe('east');
    expect(sideOfRegion('ZZ')).toBeNull();
    expect(sideOfRegion('')).toBeNull();
    expect(sideOfRegion('pa')).toBeNull(); // codes are upper case, as the importer stores them
  });

  it('an NPA takes its region’s side; an override beats it; non-geographic or unknown NPAs have none', () => {
    const ctx = testCtx();
    withNpa(ctx, '717', 'PA');
    withNpa(ctx, '612', 'MN');
    withNpa(ctx, '500', '', false);
    withNpa(ctx, '999', 'PA', false);
    expect(sideOfNpa(ctx, '717')).toBe('east');
    expect(sideOfNpa(ctx, '612')).toBe('west');
    expect(sideOfNpa(ctx, '500')).toBeNull();
    expect(sideOfNpa(ctx, '999')).toBeNull();
    expect(sideOfNpa(ctx, '201')).toBeNull(); // not in the table
    setNpaOverride(ctx, '717', 'west', 7);
    expect(sideOfNpa(ctx, '717')).toBe('west');
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: 7, action: 'npa.home_override', target: 'npa:717' });
    setNpaOverride(ctx, '717', null, 7);
    expect(sideOfNpa(ctx, '717')).toBe('east');
    // An override never makes a non-geographic NPA a block.
    setNpaOverride(ctx, '500', 'east', 7);
    expect(sideOfNpa(ctx, '500')).toBeNull();
  });

  it('labels', () => {
    expect(sideLabel('east')).toBe('East (core 1)');
    expect(sideLabel('west')).toBe('West (core 2)');
  });
});
