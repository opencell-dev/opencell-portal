// Pure parsers for the files the weekly NANPA refresh imports (portal spec
// §4.4; the P2 plan's "Data sources" appendix says where each comes from and
// its quirks). Each keeps only the rows the portal can use, and throws
// `nanpa: unexpected header …` when a file's header is not the one this code
// was written for: a format change must fail the refresh loudly (applyNanpa
// then writes nothing), never import an empty or garbled table.

export interface ExchangeRow {
  npaNxx: string;
  npa: string;
  nxx: string;
  region: string;
  /** The rate-center key (rcKey): NANPA's 10-character code (US), the exchange area (Canada). */
  rateCenter: string;
  ocn: string | null;
  company: string | null;
}

export interface NpaRow {
  npa: string;
  /** A state, province or country code; '' when the name is not one this file knows. */
  region: string;
  /** The routing table's code (OCSS spec §3.3): US-XX, CA-XX, a country's ISO alpha-2. Null: non-geographic, or an unknown name. */
  stateCode: string | null;
  geographic: boolean;
  inService: boolean;
}

export interface RateCenterRow {
  region: string;
  /** The key exchanges.rateCenter uses (rcKey). */
  name: string;
  /** The name as people write it (Lancaster, Montréal). */
  display: string;
  lat: number | null;
  lon: number | null;
}

function unexpected(what: string, got: string): Error {
  return new Error(`nanpa: unexpected header in ${what}: ${JSON.stringify(got.slice(0, 200))}`);
}

/** RFC 4180 CSV: quoted fields with "" escapes, commas and line breaks inside quotes, CRLF or LF rows. */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += c;
    }
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * A rate center's key: upper case, accents and dots removed, single spaces.
 * The same function keys NANPA's codes, CNAC's exchange areas and Local
 * Calling Guide's names, so they join (Montréal = MONTREAL, St. John's = ST JOHN'S).
 */
export function rcKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** NPA and NXX: 2-9 first, never N11 (firmware nanp_code_ok); NPA 883 is never one (numbering-plan.md). */
function codeOk(npa: string, nxx: string): boolean {
  const ok = (c: string) => /^[2-9]\d\d$/.test(c) && !c.endsWith('11');
  return ok(npa) && ok(nxx) && npa !== '883';
}

const orNull = (s: string | undefined) => (s && s.trim() !== '' ? s.trim() : null);

const CO_HEADER = ['State', 'NPA-NXX', 'OCN', 'Company', 'RateCenter', 'EffectiveDate', 'Use', 'AssignDate', 'Initial/Growth', 'Pooled Code', 'In Service'];

/**
 * NANPA's US CO-code report (CoCodeAssignment_Utilized_AllStates_Public):
 * tab-separated, every field right-padded; the header has a 12th cell
 * `File Updated MM/DD/YYYY`. Keeps Use = AS (assigned, including codes
 * effective in the future); drops UA and the XXXXXXXXXX placeholder rate
 * center. NANPA writes the Northern Mariana Islands as NN; the portal uses MP.
 */
export function parseCoCodes(text: string): ExchangeRow[] {
  const lines = text.split(/\r?\n/);
  const head = lines[0].split('\t').map((c) => c.trim());
  if (CO_HEADER.some((h, i) => head[i] !== h) || !/^File Updated/.test(head[11] ?? '')) throw unexpected('the CO-code file', lines[0]);
  const out: ExchangeRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    const c = line.split('\t').map((x) => x.trim());
    if (c[6] !== 'AS') continue;
    const m = /^(\d{3})-(\d{3})$/.exec(c[1] ?? '');
    if (!m || !codeOk(m[1], m[2])) continue;
    const rateCenter = rcKey(c[4] ?? '');
    if (rateCenter === '' || /^X+$/.test(rateCenter)) continue;
    const region = c[0] === 'NN' ? 'MP' : c[0];
    if (!/^[A-Z]{2}$/.test(region)) continue;
    out.push({
      npaNxx: m[1] + m[2],
      npa: m[1],
      nxx: m[2],
      region,
      rateCenter,
      ocn: orNull(c[2]),
      company: orNull(c[3]?.replace(/^"(.*)"$/, '$1')),
    });
  }
  return out;
}

const CNAC_HEADER = ['NPA', 'CO Code (NXX)', 'Status', 'Pooled', 'Exchange Area', 'Province', 'Company', 'OCN', 'Date Assigned', 'Remarks'];
const CNAC_KEEP = new Set(['In Service', 'Assigned']);

/**
 * CNAC's Canadian CO-code status (COCodeStatus_ALL.csv). Row 2 is a
 * date-only row (,,,,,,,,,2026-10-31), skipped like every row without codes.
 * Keeps In Service and Assigned; the rate center is the exchange area.
 */
export function parseCnacCodes(text: string): ExchangeRow[] {
  const rows = splitCsv(text);
  const head = rows[0] ?? [];
  if (CNAC_HEADER.some((h, i) => head[i] !== h)) throw unexpected('the CNAC file', head.join(','));
  const out: ExchangeRow[] = [];
  for (const c of rows.slice(1)) {
    const [npa, nxx, status, , area, province, company, ocn] = c.map((x) => x.trim());
    if (!CNAC_KEEP.has(status) || !codeOk(npa ?? '', nxx ?? '')) continue;
    const rateCenter = rcKey(area ?? '');
    if (rateCenter === '' || !/^[A-Z]{2}$/.test(province ?? '')) continue;
    out.push({ npaNxx: npa + nxx, npa, nxx, region: province, rateCenter, ocn: orNull(ocn), company: orNull(company) });
  }
  return out;
}

/** A place name for matching: upper case, no accents, & and / as AND, dots and dashes as spaces. */
function placeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/&|\//g, ' AND ')
    .replace(/[.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// NANPA's npa_report.csv names Canadian provinces and the other NANP
// countries in LOCATION. Two Canadian NPAs span provinces (867: NT, YT, NU;
// 902/782: NS, PE): each set is on one side of the split (spec §4.3), so the
// NPA takes the first; its exchanges keep their own province (CNAC).
const REGION_OF: Record<string, string> = {
  ALBERTA: 'AB',
  'BRITISH COLUMBIA': 'BC',
  MANITOBA: 'MB',
  'NEW BRUNSWICK': 'NB',
  'NEWFOUNDLAND AND LABRADOR': 'NL',
  NEWFOUNDLAND: 'NL',
  'NOVA SCOTIA': 'NS',
  'NOVA SCOTIA PRINCE EDWARD ISLAND': 'NS',
  'PRINCE EDWARD ISLAND': 'PE',
  'NORTHWEST TERRITORIES': 'NT',
  'NORTHWEST TERRITORIES YUKON NUNAVUT': 'NT',
  YUKON: 'YT',
  'YUKON TERRITORY': 'YT',
  NUNAVUT: 'NU',
  ONTARIO: 'ON',
  QUEBEC: 'QC',
  SASKATCHEWAN: 'SK',
  JAMAICA: 'JM',
  BAHAMAS: 'BS',
  BARBADOS: 'BB',
  BERMUDA: 'BM',
  'DOMINICAN REPUBLIC': 'DO',
  'TRINIDAD AND TOBAGO': 'TT',
  ANGUILLA: 'AI',
  'ANTIGUA AND BARBUDA': 'AG',
  'BRITISH VIRGIN ISLANDS': 'VG',
  'CAYMAN ISLANDS': 'KY',
  DOMINICA: 'DM',
  GRENADA: 'GD',
  MONTSERRAT: 'MS',
  'ST KITTS AND NEVIS': 'KN',
  'ST LUCIA': 'LC',
  'ST VINCENT AND GRENADINES': 'VC',
  'ST VINCENT AND THE GRENADINES': 'VC',
  'SINT MAARTEN': 'SX',
  'TURKS AND CAICOS ISLANDS': 'TC',
  // US territories come with COUNTRY US and a code, except this one.
  CNMI: 'MP',
};

function regionOf(location: string): string {
  if (/^[A-Z]{2}$/.test(location)) return location;
  return REGION_OF[placeName(location)] ?? '';
}

/** 902/782 are CA-NS and 867 CA-NT because REGION_OF takes the first province of each. */
function stateCodeOf(region: string, country: string): string | null {
  if (region === '') return null;
  if (country === 'US') return `US-${region}`;
  if (country === 'CANADA') return `CA-${region}`;
  return region;
}

/**
 * NANPA's NPA list (npa_report.csv): line 1 is a `File Date,…` preamble, the
 * header is line 2. Geographic means USE = G with a country (a G code with no
 * country is not assigned yet); in service is IN_SERVICE = Y.
 */
export function parseNpas(text: string): NpaRow[] {
  const rows = splitCsv(text);
  if (!/^File Date$/.test(rows[0]?.[0]?.trim() ?? '')) throw unexpected('the NPA file', (rows[0] ?? []).join(','));
  const head = (rows[1] ?? []).map((h) => h.trim());
  const col = (name: string) => head.indexOf(name);
  const [iNpa, iUse, iLoc, iCountry, iIn] = ['NPA_ID', 'USE', 'LOCATION', 'COUNTRY', 'IN_SERVICE'].map(col);
  if ([iNpa, iUse, iLoc, iCountry, iIn].some((i) => i < 0)) throw unexpected('the NPA file', head.join(','));
  const out: NpaRow[] = [];
  for (const c of rows.slice(2)) {
    const npa = c[iNpa]?.trim() ?? '';
    if (!/^[2-9]\d\d$/.test(npa) || npa.endsWith('11') || npa === '883') continue;
    const country = c[iCountry]?.trim() ?? '';
    const location = c[iLoc]?.trim() ?? '';
    const geographic = c[iUse]?.trim() === 'G' && country !== '';
    const region = geographic ? regionOf(location) : '';
    out.push({ npa, region, stateCode: stateCodeOf(region, country), geographic, inService: c[iIn]?.trim() === 'Y' });
  }
  return out;
}

// HTML 4's Latin-1 entities, U+00A0 to U+00FF in order: Local Calling
// Guide's XML declares them in an inline DTD and uses a few in names.
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
LATIN1.split(' ').forEach((name, i) => {
  ENTITY[name] = String.fromCodePoint(0xa0 + i);
});

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (all, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    return ENTITY[e] ?? all;
  });
}

const CANADA = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

function tag(rec: string, name: string): string {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(rec);
  return m ? decode(m[1]).trim() : '';
}

function coord(s: string): number | null {
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * One region's rate centers from Local Calling Guide (xmlrc.php?region=XX).
 * Records that point elsewhere (see-exch set) are aliases and skipped. A US
 * record is keyed by rcshort (= NANPA's RateCenter); a Canadian one by its
 * normalized name first (CNAC's exchange areas join on it), then rcshort.
 * The first record for a key wins.
 */
export function parseRateCenters(text: string): RateCenterRow[] {
  if (!/<root>/.test(text)) throw unexpected('a Local Calling Guide rate-center file', text);
  const out: RateCenterRow[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/<rcdata>([\s\S]*?)<\/rcdata>/g)) {
    const rec = m[1];
    if (tag(rec, 'see-exch') !== '') continue;
    const region = tag(rec, 'region');
    const display = tag(rec, 'rc').replace(/\s+/g, ' ');
    if (!/^[A-Z]{2}$/.test(region) || display === '') continue;
    const lat = coord(tag(rec, 'rc-lat'));
    const lon = coord(tag(rec, 'rc-lon'));
    const keys = CANADA.has(region) ? [rcKey(display), rcKey(tag(rec, 'rcshort'))] : [rcKey(tag(rec, 'rcshort'))];
    for (const name of keys) {
      if (name === '' || seen.has(`${region}|${name}`)) continue;
      seen.add(`${region}|${name}`);
      out.push({ region, name, display, lat, lon });
    }
  }
  return out;
}

/** The region codes Local Calling Guide's region list links to (region=XX), each once, in page order. */
export function lcgRegions(page: string): string[] {
  return [...new Set([...page.matchAll(/[?&]region=([A-Z]{2})\b/g)].map((m) => m[1]))];
}
