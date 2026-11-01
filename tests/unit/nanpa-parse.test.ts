import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sideOfStateCode } from '@/lib/numbers/homing';
import { lcgRegions, parseCnacCodes, parseCoCodes, parseNpas, parseRateCenters, rcKey, splitCsv } from '@/lib/numbers/nanpa-parse';

// Trimmed real files (portal P2 plan, "Data sources"), headers and quirks kept.
const FIX = 'tests/fixtures/nanpa';
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');

describe('splitCsv (RFC 4180)', () => {
  it('quoted fields, doubled quotes, commas and newlines inside quotes, CRLF', () => {
    expect(splitCsv('a,"b,c","d ""e""",\r\n"x\ny",2\r\n')).toEqual([
      ['a', 'b,c', 'd "e"', ''],
      ['x\ny', '2'],
    ]);
    expect(splitCsv('')).toEqual([]);
  });
});

describe('rcKey', () => {
  it('upper case, no accents, no dots, single spaces', () => {
    expect(rcKey('  Montréal ')).toBe('MONTREAL');
    expect(rcKey("St. John's")).toBe("ST JOHN'S");
    expect(rcKey('LANCASTER ')).toBe('LANCASTER');
    expect(rcKey('Fort  St. John')).toBe('FORT ST JOHN');
  });
});

describe('parseCoCodes (NANPA, US)', () => {
  const rows = parseCoCodes(read('co-codes.txt'));

  it('keeps the assigned (AS) codes only, trimmed', () => {
    // 37 data rows: 33 AS (one in NN), 4 UA (907-211, 670-211, 717-211, 717-570).
    expect(rows).toHaveLength(33);
    expect(rows.find((r) => r.npaNxx === '717464')).toEqual({
      npaNxx: '717464',
      npa: '717',
      nxx: '464',
      region: 'PA',
      rateCenter: 'LANCASTER',
      ocn: '9208',
      company: 'VERIZON PENNSYLVANIA, INC.',
    });
    expect(rows.some((r) => r.npaNxx === '717570')).toBe(false); // UA: available
    expect(rows.some((r) => r.nxx.endsWith('11'))).toBe(false);
  });

  it('keeps a code with a future effective date, and maps NN to MP', () => {
    expect(rows.find((r) => r.npaNxx === '251541')?.rateCenter).toBe('MOBILE');
    expect(rows.find((r) => r.npaNxx === '670233')).toMatchObject({ region: 'MP', rateCenter: 'SAIPAN' });
  });

  it('drops N11 codes, NPA 883 and the XXXXXXXXXX placeholder even when marked AS', () => {
    const head = read('co-codes.txt').split('\r\n')[0];
    const row = (npaNxx: string, rc: string) => `PA   \t${npaNxx}\t9208\t"X"\t${rc}\t\tAS \t\t\tN\tYes`;
    const text = [head, row('717-411', 'LANCASTER'), row('883-464', 'LANCASTER'), row('717-299', 'XXXXXXXXXX'), row('717-298', 'LANCASTER')].join('\r\n');
    expect(parseCoCodes(text).map((r) => r.npaNxx)).toEqual(['717298']);
  });

  it('refuses a file whose header changed', () => {
    expect(() => parseCoCodes('State\tNPA\tOCN\r\nPA\t717\t1\r\n')).toThrow(/nanpa: unexpected header/);
    expect(() => parseCoCodes('')).toThrow(/nanpa: unexpected header/);
  });
});

describe('parseCnacCodes (CNAC, Canada)', () => {
  const rows = parseCnacCodes(read('cnac.csv'));

  it('keeps In Service and Assigned codes, skipping the date-only row', () => {
    // 16 data rows: 13 In Service or Assigned, 1 Available, 2 For Special Use.
    expect(rows).toHaveLength(13);
    expect(rows.find((r) => r.npaNxx === '263223')).toEqual({
      npaNxx: '263223',
      npa: '263',
      nxx: '223',
      region: 'QC',
      rateCenter: 'MONTREAL',
      ocn: '8303',
      company: 'TELUS Mobility',
    });
    expect(rows.find((r) => r.npaNxx === '709207')?.rateCenter).toBe("ST JOHN'S");
    expect(rows.some((r) => r.npaNxx === '236561')).toBe(false); // Available
    expect(rows.some((r) => r.npaNxx === '416411')).toBe(false); // For Special Use, N11
  });

  it('refuses a changed header', () => {
    expect(() => parseCnacCodes('"NPA","NXX"\r\n204,200\r\n')).toThrow(/nanpa: unexpected header/);
  });
});

describe('parseNpas', () => {
  const rows = parseNpas(read('npas.csv'));
  const by = (npa: string) => rows.find((r) => r.npa === npa);

  it('reads the header on line 2, after the File Date preamble', () => {
    expect(rows).toHaveLength(41); // 43 rows less 611 (N11) and 883
    expect(by('717')).toEqual({ npa: '717', region: 'PA', stateCode: 'US-PA', geographic: true, inService: true });
  });

  it('maps provinces and countries to codes', () => {
    expect(by('204')?.region).toBe('MB');
    expect(by('263')?.region).toBe('QC');
    expect(by('709')?.region).toBe('NL');
    expect(by('867')?.region).toBe('NT'); // NORTHWEST TERRITORIES -YUKON - NUNAVUT: all West
    expect(by('902')?.region).toBe('NS'); // NOVA SCOTIA - PRINCE EDWARD ISLAND: both East
    expect(by('876')?.region).toBe('JM');
    expect(by('268')?.region).toBe('AG'); // ANTIGUA/BARBUDA
    expect(by('649')?.region).toBe('TC'); // TURKS & CAICOS ISLANDS
    expect(by('758')?.region).toBe('LC'); // ST. LUCIA
    expect(by('784')?.region).toBe('VC');
    expect(by('869')?.region).toBe('KN');
    expect(by('670')?.region).toBe('MP'); // CNMI
    expect(by('787')?.region).toBe('PR');
  });

  it('non-geographic and not-yet-assigned NPAs', () => {
    expect(by('500')).toMatchObject({ geographic: false, inService: true });
    expect(by('221')).toMatchObject({ geographic: false, inService: false }); // G, no country yet
    expect(by('200')).toMatchObject({ geographic: false });
    expect(by('611')).toBeUndefined(); // N11
    expect(by('883')).toBeUndefined(); // never an NPA here
  });

  it('refuses a changed header', () => {
    expect(() => parseNpas('NPA_ID,USE\r\n717,G\r\n')).toThrow(/nanpa: unexpected header/);
    expect(() => parseNpas('File Date,10/31/2026\r\nNPA,USE\r\n')).toThrow(/nanpa: unexpected header/);
  });
});

describe('NpaRow.stateCode (OCSS spec §3.3)', () => {
  const rows = parseNpas(read('npas.csv'));
  const code = (npa: string) => rows.find((r) => r.npa === npa)?.stateCode;

  it('US-XX, CA-XX, a country alpha-2; 902 is CA-NS and 867 CA-NT', () => {
    expect(code('717')).toBe('US-PA');
    expect(code('202')).toBe('US-DC');
    expect(code('204')).toBe('CA-MB');
    expect(code('902')).toBe('CA-NS');
    expect(code('867')).toBe('CA-NT');
    expect(code('876')).toBe('JM');
    expect(code('649')).toBe('TC');
  });

  it('non-geographic or not assigned yet is null', () => {
    expect(code('200')).toBeNull();
    expect(code('221')).toBeNull();
  });

  it('keeps Kentucky and the Cayman Islands, Mississippi and Montserrat apart', () => {
    const head = 'File Date,11/01/2026\nNPA_ID,USE,LOCATION,COUNTRY,IN_SERVICE\n';
    const r = parseNpas(`${head}606,G,KY,US,Y\n345,G,CAYMAN ISLANDS,CAYMAN ISLANDS,Y\n228,G,MS,US,Y\n664,G,MONTSERRAT,MONTSERRAT,Y\n670,G,CNMI,US,Y\n222,G,ATLANTIS,ATLANTIS,Y\n`);
    expect(r.map((x) => [x.npa, x.region, x.stateCode])).toEqual([
      ['606', 'KY', 'US-KY'],
      ['345', 'KY', 'KY'],
      ['228', 'MS', 'US-MS'],
      ['664', 'MS', 'MS'],
      ['670', 'MP', 'US-MP'],
      ['222', '', null], // an unknown name
    ]);
  });
});

/** The cross-check (plan P5, Task 4): the portal's reading of NANPA's report is the routing table's, or portal and table disagree on a home. */
describe('parseNpas on the real report, against the routing table', () => {
  // The route CSV is the deployed table's source (File Date 10/31/2026; 454 NPAs). The report was
  // fetched on 2026-11-01 and is dated 11/01/2026, a day later, with the same 454: compare only NPAs in both.
  const table = new Map(
    read('route-npa-2026-10-31.csv')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => l.split(',') as [string, string]),
  );
  const rows = parseNpas(read('npa_report-2026-11-01.csv')).filter((r) => r.geographic && r.inService);

  it('reads every state code the table has', () => {
    expect(table.size).toBe(454);
    const both = rows.filter((r) => table.has(r.npa));
    expect(both.length).toBe(454);
    expect(both.map((r) => [r.npa, r.stateCode])).toEqual(both.map((r) => [r.npa, table.get(r.npa)]));
  });

  it('every code is on a side of the split, and the split is the table count (282 East, 172 West)', () => {
    const sides = rows.map((r) => sideOfStateCode(r.stateCode ?? ''));
    expect(sides.filter((s) => s === 'east')).toHaveLength(282);
    expect(sides.filter((s) => s === 'west')).toHaveLength(172);
  });
});

describe('parseRateCenters (Local Calling Guide)', () => {
  it('US: keyed by rcshort, aliases skipped, coordinates decimal', () => {
    const rows = parseRateCenters(read('rc_PA.xml'));
    expect(rows.find((r) => r.name === 'LANCASTER')).toEqual({ region: 'PA', name: 'LANCASTER', display: 'Lancaster', lat: 40.037845, lon: -76.306671 });
    expect(rows.find((r) => r.name === 'AARONSBURG')).toBeUndefined(); // see-exch: an alias
    expect(rows.find((r) => r.name === 'HARISBGZN1')?.display).toBe('Harrisburg City Zone-1');
    expect(rows).toHaveLength(5);
  });

  it('Canada: also keyed by the normalized name, entities decoded', () => {
    const qc = parseRateCenters(read('rc_QC.xml'));
    expect(qc.find((r) => r.name === 'MONTREAL')).toMatchObject({ region: 'QC', display: 'Montréal', lat: 45.502395 });
    expect(qc.some((r) => r.display === 'Montréal-Est')).toBe(false); // alias
    expect(qc.some((r) => r.display.startsWith('Baie'))).toBe(false); // an alias of Pointe-Claire
    expect(qc).toHaveLength(1);
    const nl = parseRateCenters(read('rc_NL.xml'));
    expect(nl.find((r) => r.name === "ST JOHN'S")?.display).toBe("St John's"); // &#039; decoded
  });

  it('empty coordinates are null; a non-LCG document is refused', () => {
    const t = read('rc_PA.xml').replace(/<rc-lat>40\.037845<\/rc-lat>/, '<rc-lat></rc-lat>');
    expect(parseRateCenters(t).find((r) => r.name === 'LANCASTER')).toMatchObject({ lat: null, lon: -76.306671 });
    expect(() => parseRateCenters('<html>maintenance</html>')).toThrow(/nanpa: unexpected header/);
  });

  it('lcgRegions reads the region codes off the list page', () => {
    const page = '<a href="lca_rcdist.php?region=PA">Pennsylvania</a> <a href="xmlrc.php?region=QC">x</a> <a href="?region=PA">dup</a>';
    expect(lcgRegions(page)).toEqual(['PA', 'QC']);
  });
});
