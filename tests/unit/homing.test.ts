import { describe, expect, it } from 'vitest';
import { npas, settings } from '@/db/schema';
import { sideLabel, sideOfNpa, sideOfRegion, sideOfStateCode } from '@/lib/numbers/homing';
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

function withNpa(ctx: ReturnType<typeof testCtx>, npa: string, region: string, geographic = true, stateCode: string | null = null) {
  ctx.db.insert(npas).values({ npa, region, stateCode, geographic, inService: true, updatedAt: 1 }).run();
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

  it('an NPA takes its state code’s side; non-geographic or unknown NPAs have none', () => {
    const ctx = testCtx();
    withNpa(ctx, '717', 'PA', true, 'US-PA');
    withNpa(ctx, '612', 'MN', true, 'US-MN');
    withNpa(ctx, '500', '', false);
    withNpa(ctx, '999', 'PA', false, 'US-PA');
    expect(sideOfNpa(ctx, '717')).toBe('east');
    expect(sideOfNpa(ctx, '612')).toBe('west');
    expect(sideOfNpa(ctx, '500')).toBeNull();
    expect(sideOfNpa(ctx, '999')).toBeNull();
    expect(sideOfNpa(ctx, '201')).toBeNull(); // not in the table
  });

  it('a row from before state codes goes by its region until the next refresh fills the code in', () => {
    const ctx = testCtx();
    withNpa(ctx, '717', 'PA');
    expect(sideOfNpa(ctx, '717')).toBe('east');
  });

  it('there is no portal override any more: nothing in the settings table moves a home', () => {
    const ctx = testCtx();
    withNpa(ctx, '717', 'PA', true, 'US-PA');
    ctx.db.insert(settings).values({ key: 'npa_home:717', value: 'west' }).run();
    expect(sideOfNpa(ctx, '717')).toBe('east');
  });

  it('labels', () => {
    expect(sideLabel('east')).toBe('East (core 1)');
    expect(sideLabel('west')).toBe('West (core 2)');
  });
});

describe('sideOfStateCode (OCSS spec §3.3)', () => {
  const east = 'US-AL US-CT US-DC US-DE US-FL US-GA US-IL US-IN US-KY US-MA US-MD US-ME US-MI US-MS US-NC US-NH US-NJ US-NY US-OH US-PA US-RI US-SC US-TN US-VA US-VT US-WI US-WV US-PR US-VI CA-ON CA-QC CA-NB CA-NS CA-PE CA-NL AG AI BB BM BS DM DO GD JM KN KY LC MS SX TC TT VC VG';
  const west = 'US-AK US-AR US-AZ US-CA US-CO US-HI US-IA US-ID US-KS US-LA US-MN US-MO US-MT US-ND US-NE US-NM US-NV US-OK US-OR US-SD US-TX US-UT US-WA US-WY US-GU US-MP US-AS CA-MB CA-SK CA-AB CA-BC CA-YT CA-NT CA-NU';
  it.each(east.split(' '))('%s → east', (c) => expect(sideOfStateCode(c)).toBe('east'));
  it.each(west.split(' '))('%s → west', (c) => expect(sideOfStateCode(c)).toBe('west'));
  it('the ones that matter', () => {
    expect(sideOfStateCode('US-KY')).toBe('east');
    expect(sideOfStateCode('US-LA')).toBe('west');
    expect(sideOfStateCode('KY')).toBe('east');
    expect(sideOfStateCode('CA-NT')).toBe('west');
  });
  it('a bare state, a code in neither list or nothing is no side', () => {
    expect(sideOfStateCode('PA')).toBeNull();
    expect(sideOfStateCode('US-ZZ')).toBeNull();
    expect(sideOfStateCode('')).toBeNull();
  });
});
