import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { count, desc, eq, isNull } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { exchanges, nanpaRefreshes, npas } from '@/db/schema';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { type ExchangeRow, lcgRegions, parseCnacCodes, parseCoCodes, parseNpas, parseRateCenters, type RateCenterRow } from './nanpa-parse';
import type { OfferResult } from './route-delegate';

// The weekly NANPA refresh (portal spec §4.4): new NXX assignments become
// searchable, a code that leaves NANPA's file is withdrawn (kept for the
// numbers already issued in it, never offered again). What core.blocks lacks
// is then signed and offered as blocks (offerMissingNpas, route-delegate.ts).
// Run by `oc-portal-admin nanpa-refresh` from oc-portal-nanpa.timer.

/** Where the files come from (the P2 plan's "Data sources" appendix). Every one is a plain GET. */
export const NANPA_URLS = {
  coCodes: 'https://reports.nanpa.com/public/CoCodeAssignment_Utilized_AllStates_Public.zip',
  cnac: 'https://www.cnac.ca/data/COCodeStatus_ALL.zip',
  npas: 'https://reports.nanpa.com/public/npa_report.csv',
  lcgRegions: 'https://www.localcallingguide.com/lca_listregion.php',
  lcgRc: 'https://www.localcallingguide.com/xmlrc.php?region=',
};
export type NanpaUrls = typeof NANPA_URLS;

export const USER_AGENT = 'OpenCell-portal (opencell@k4ozi.com)';
const FILE_TIMEOUT_MS = 60_000;
/** Local Calling Guide asks for restraint: one region at a time, 1.5 s apart. */
const LCG_DELAY_MS = 1500;
/** A refresh that would leave fewer live exchanges than this share of today's is a truncated download. */
const MIN_SHARE = 0.9;
/** A region with fewer live exchanges than this can lose a tenth in a real week. */
const MIN_REGION = 200;

const CANADA = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

export interface NanpaFiles {
  coCodes: string;
  /** Canada's codes. Missing: the Canadian exchanges are left as they are. */
  cnac?: string;
  npas: string;
  /** One Local Calling Guide XML per region. Missing: the rate centers are left as they are. */
  rateCenters?: string[];
  /** What could not be fetched (and so was left as it was). */
  errors?: string[];
}

export interface RefreshResult {
  /**
   * Geographic NPAs this refresh saw for the first time, for the log. Empty on
   * the first import. What gets offered as a block is decided by what
   * core.blocks lacks, not by this (plan P5 decision 3).
   */
  newNpas: string[];
  newExchanges: number;
  withdrawn: number;
  restored: number;
  rateCenters: number;
  errors: string[];
  /** What the refresh then did for the routing table (absent: it was not run). */
  offers?: OfferResult;
}

type FetchImpl = typeof fetch;

async function get(url: string, fetchImpl: FetchImpl): Promise<Uint8Array> {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`nanpa: GET ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The one text file inside a zip (or the body itself when it is not one: PK\x03\x04 is a zip's signature). */
function unzipText(body: Uint8Array, encoding: 'latin1' | 'utf-8'): string {
  const isZip = body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04;
  let data = body;
  if (isZip) {
    const entries = Object.entries(unzipSync(body)).filter(([name]) => /\.(txt|csv)$/i.test(name));
    if (entries.length !== 1) throw new Error(`nanpa: expected one .txt or .csv in the zip, found ${entries.length}`);
    data = entries[0][1];
  }
  return new TextDecoder(encoding).decode(data);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download the files. The US CO codes and the NPA list are required (a
 * failure throws: nothing to refresh from). Canada's codes and the rate
 * centers are each skipped on failure, with the reason in `errors`, so the
 * last good copy stays.
 */
export async function fetchNanpa(urls: NanpaUrls = NANPA_URLS, fetchImpl: FetchImpl = fetch, opts = { delayMs: LCG_DELAY_MS }): Promise<NanpaFiles> {
  const errors: string[] = [];
  const coCodes = unzipText(await get(urls.coCodes, fetchImpl), 'latin1');
  const npaText = new TextDecoder('utf-8').decode(await get(urls.npas, fetchImpl));
  let cnac: string | undefined;
  try {
    cnac = unzipText(await get(urls.cnac, fetchImpl), 'utf-8');
  } catch (e) {
    errors.push(`cnac skipped: ${(e as Error).message}`);
  }
  let rateCenters: string[] | undefined;
  let region = '(list)';
  try {
    const regions = lcgRegions(new TextDecoder('utf-8').decode(await get(urls.lcgRegions, fetchImpl)));
    if (regions.length === 0) throw new Error('no regions on the list page');
    const texts: string[] = [];
    for (const r of regions) {
      region = r;
      await sleep(opts.delayMs);
      texts.push(new TextDecoder('utf-8').decode(await get(urls.lcgRc + r, fetchImpl)));
    }
    rateCenters = texts;
  } catch (e) {
    errors.push(`rate centers skipped (region ${region}): ${(e as Error).message}`);
  }
  return { coCodes, cnac, npas: npaText, rateCenters, errors };
}

/**
 * The same files from a directory (`nanpa-refresh --dir`): co-codes.txt and
 * npas.csv required; cnac.csv and rc_*.xml (one per region) optional.
 */
export function readNanpaDir(dir: string): NanpaFiles {
  const names = readdirSync(dir);
  const rc = names.filter((n) => /^rc_[A-Z]{2}\.xml$/.test(n)).sort();
  return {
    coCodes: readFileSync(join(dir, 'co-codes.txt'), 'latin1'),
    cnac: names.includes('cnac.csv') ? readFileSync(join(dir, 'cnac.csv'), 'utf8') : undefined,
    npas: readFileSync(join(dir, 'npas.csv'), 'utf8'),
    rateCenters: rc.length > 0 ? rc.map((n) => readFileSync(join(dir, n), 'utf8')) : undefined,
    errors: [],
  };
}

const tally = (regions: string[]) => {
  const m = new Map<string, number>();
  for (const r of regions) m.set(r, (m.get(r) ?? 0) + 1);
  return m;
};

/**
 * A truncated download must not withdraw the country (the plan, Task 4), nor
 * a province or a state hiding behind the total: Canada is only 13 % of the
 * exchanges, and Texas 7 %. So: under 90 % of the live count for either source
 * (the US file, CNAC's), or for a region big enough for 10 % to mean something, throws.
 */
function refuseIfTruncated(live: string[], incoming: string[]): void {
  const refuse = (what: string, got: number, had: number) => {
    throw new Error(`nanpa: ${what}: this run has ${got} exchanges, under 90 % of the ${had} live ones; refusing (a truncated download?)`);
  };
  const was = tally(live);
  const now = tally(incoming);
  const inCanada = (m: Map<string, number>, canada: boolean) => [...m].reduce((n, [r, c]) => (CANADA.has(r) === canada ? n + c : n), 0);
  for (const [what, canada] of [['the United States', false], ['Canada', true]] as const) {
    const had = inCanada(was, canada);
    if (had > 0 && inCanada(now, canada) < MIN_SHARE * had) refuse(what, inCanada(now, canada), had);
  }
  for (const [region, had] of was) {
    if (had >= MIN_REGION && (now.get(region) ?? 0) < MIN_SHARE * had) refuse(region, now.get(region) ?? 0, had);
  }
}

/**
 * Bring the tables up to date from `files`, in one transaction: upsert the
 * NPAs; add new exchanges; withdraw those missing from this run (only within
 * what this run covers: Canada only when CNAC's file is here); restore those
 * that came back; upsert the rate centers when they are here. Refuses (throws,
 * nothing written) when a source or a big region would keep under 90 % of its
 * live exchanges (refuseIfTruncated). Logs the
 * result to nanpa_refreshes and the audit.
 */
export function applyNanpa(ctx: Ctx, files: NanpaFiles): RefreshResult {
  // Parse everything first: a format change throws before any write.
  const npaRows = parseNpas(files.npas);
  const rows = new Map<string, ExchangeRow>();
  for (const r of parseCoCodes(files.coCodes)) if (!rows.has(r.npaNxx)) rows.set(r.npaNxx, r);
  if (files.cnac !== undefined) for (const r of parseCnacCodes(files.cnac)) if (!rows.has(r.npaNxx)) rows.set(r.npaNxx, r);
  const rcRows = new Map<string, RateCenterRow>();
  for (const text of files.rateCenters ?? []) {
    for (const r of parseRateCenters(text)) if (!rcRows.has(`${r.region}|${r.name}`)) rcRows.set(`${r.region}|${r.name}`, r);
  }
  const now = ctx.now();
  const errors = [...(files.errors ?? [])];
  for (const n of npaRows) if (n.geographic && n.inService && n.region === '') errors.push(`npa ${n.npa}: its region is not one the portal knows`);
  const inScope = (region: string) => files.cnac !== undefined || !CANADA.has(region);
  const client = ctx.db.$client;

  const result = ctx.db.transaction((tx) => {
    // ---- NPAs ----
    const firstImport = tx.select({ n: count() }).from(npas).get()!.n === 0;
    const before = new Map(tx.select().from(npas).all().map((r) => [r.npa, r]));
    const upsertNpa = client.prepare(
      `INSERT INTO npas (npa, region, state_code, geographic, in_service, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(npa) DO UPDATE SET region = excluded.region, state_code = excluded.state_code, geographic = excluded.geographic, in_service = excluded.in_service, updated_at = excluded.updated_at`,
    );
    const newNpas: string[] = [];
    for (const n of npaRows) {
      const old = before.get(n.npa);
      if (!firstImport && n.geographic && !old?.geographic) newNpas.push(n.npa);
      if (!old || old.region !== n.region || old.stateCode !== n.stateCode || old.geographic !== n.geographic || old.inService !== n.inService) {
        upsertNpa.run(n.npa, n.region, n.stateCode, n.geographic ? 1 : 0, n.inService ? 1 : 0, now);
      }
    }

    // ---- exchanges ----
    const current = tx.select().from(exchanges).all();
    refuseIfTruncated(
      current.filter((e) => e.withdrawnAt === null && inScope(e.region)).map((e) => e.region),
      [...rows.values()].filter((r) => inScope(r.region)).map((r) => r.region),
    );
    const byCode = new Map(current.map((e) => [e.npaNxx, e]));
    const insert = client.prepare(
      'INSERT INTO exchanges (npa_nxx, npa, nxx, region, rate_center, ocn, company, first_seen_at, withdrawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    );
    const update = client.prepare('UPDATE exchanges SET region = ?, rate_center = ?, ocn = ?, company = ?, withdrawn_at = NULL WHERE npa_nxx = ?');
    const withdraw = client.prepare('UPDATE exchanges SET withdrawn_at = ? WHERE npa_nxx = ?');
    let newExchanges = 0;
    let restored = 0;
    let withdrawn = 0;
    for (const r of rows.values()) {
      const old = byCode.get(r.npaNxx);
      if (!old) {
        insert.run(r.npaNxx, r.npa, r.nxx, r.region, r.rateCenter, r.ocn, r.company, now);
        newExchanges++;
        continue;
      }
      if (old.withdrawnAt !== null) restored++;
      if (old.withdrawnAt !== null || old.region !== r.region || old.rateCenter !== r.rateCenter || old.ocn !== r.ocn || old.company !== r.company) {
        update.run(r.region, r.rateCenter, r.ocn, r.company, r.npaNxx);
      }
    }
    for (const e of current) {
      if (e.withdrawnAt === null && inScope(e.region) && !rows.has(e.npaNxx)) {
        withdraw.run(now, e.npaNxx);
        withdrawn++;
      }
    }

    // ---- rate centers ----
    if (files.rateCenters !== undefined) {
      const upsertRc = client.prepare(
        `INSERT INTO rate_centers (region, name, display, lat, lon) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(region, name) DO UPDATE SET display = excluded.display, lat = excluded.lat, lon = excluded.lon`,
      );
      for (const r of rcRows.values()) upsertRc.run(r.region, r.name, r.display, r.lat, r.lon);
    }

    const out: RefreshResult = { newNpas, newExchanges, withdrawn, restored, rateCenters: files.rateCenters === undefined ? 0 : rcRows.size, errors };
    tx.insert(nanpaRefreshes).values({ at: now, ok: true, detail: JSON.stringify(out) }).run();
    return out;
  });
  writeAudit(ctx, {
    actorId: null,
    action: 'nanpa.refresh',
    detail: { ...result, errors: result.errors.length },
  });
  return result;
}

/** A refresh that failed, for the admin page's log: why, and nothing else changed. */
export function logFailedRefresh(ctx: Ctx, e: unknown): void {
  const detail = { newNpas: [], newExchanges: 0, withdrawn: 0, restored: 0, rateCenters: 0, errors: [(e as Error)?.message ?? String(e)] };
  ctx.db.insert(nanpaRefreshes).values({ at: ctx.now(), ok: false, detail: JSON.stringify(detail) }).run();
  writeAudit(ctx, { actorId: null, action: 'nanpa.refresh_failed', detail: { error: detail.errors[0].slice(0, 300) } });
}

/** The newest refresh's log row gains what happened to the routing table after it. */
export function logOffers(ctx: Ctx, offers: OfferResult): void {
  const row = ctx.db.select().from(nanpaRefreshes).orderBy(desc(nanpaRefreshes.id)).limit(1).get();
  if (!row) return;
  ctx.db.update(nanpaRefreshes).set({ detail: JSON.stringify({ ...(JSON.parse(row.detail) as RefreshResult), offers }) }).where(eq(nanpaRefreshes.id, row.id)).run();
  if (offers.offered.length > 0 || offers.replayed > 0 || offers.errors.length > 0) writeAudit(ctx, { actorId: null, action: 'route.offers', detail: { offered: offers.offered, replayed: offers.replayed, errors: offers.errors.length } });
}

/** The routing table's half of a refresh's line: quiet when nothing happened. */
function offersSummary(o: OfferResult | undefined): string {
  if (!o) return '';
  return (
    `${o.offered.length > 0 ? `; offered NPAs ${o.offered.join(' ')}` : ''}` +
    `${o.replayed > 0 ? `; ${o.replayed} additions replayed` : ''}` +
    `${o.errors.length > 0 ? `; route: ${o.errors.join('; ')}` : ''}`
  );
}

/** The live (not withdrawn) exchange count, for the CLI's summary. */
export function liveExchanges(ctx: Ctx): number {
  return ctx.db.select({ n: count() }).from(exchanges).where(isNull(exchanges.withdrawnAt)).get()!.n;
}

/** The last refreshes, newest first, in words (the admin page, spec §4.4). */
export function recentRefreshes(ctx: Ctx, n: number): { id: number; at: number; ok: boolean; summary: string }[] {
  return ctx.db
    .select()
    .from(nanpaRefreshes)
    .orderBy(desc(nanpaRefreshes.at), desc(nanpaRefreshes.id))
    .limit(n)
    .all()
    .map((r) => {
      const d = JSON.parse(r.detail) as RefreshResult;
      const summary = r.ok
        ? `${d.newExchanges} new exchanges, ${d.withdrawn} withdrawn, ${d.restored} restored, ${d.rateCenters} rate centers` +
          `${d.newNpas.length > 0 ? `; new NPAs ${d.newNpas.join(' ')}` : ''}${d.errors.length > 0 ? `; ${d.errors.length} problems` : ''}${offersSummary(d.offers)}`
        : `failed: ${d.errors[0] ?? 'unknown'}`;
      return { id: r.id, at: r.at, ok: r.ok, summary };
    });
}
