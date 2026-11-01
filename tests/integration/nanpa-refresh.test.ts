import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, isNull } from 'drizzle-orm';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { exchanges, nanpaRefreshes, npas, rateCenters } from '@/db/schema';
import { runAdminAsync } from '@/lib/admin-cli';
import { listAudit } from '@/lib/audit';
import { applyNanpa, fetchNanpa, type NanpaFiles, NANPA_URLS, readNanpaDir } from '@/lib/numbers/nanpa-refresh';
import { type TestCtx, testCtx } from '../helpers/ctx';

const FIX = 'tests/fixtures/nanpa';
const co = readFileSync(join(FIX, 'co-codes.txt'), 'latin1');
const cnac = readFileSync(join(FIX, 'cnac.csv'), 'utf8');
const npaText = readFileSync(join(FIX, 'npas.csv'), 'utf8');
const rcs = ['PA', 'OH', 'QC', 'NL', 'ON'].map((r) => readFileSync(join(FIX, `rc_${r}.xml`), 'utf8'));
const files = (over: Partial<NanpaFiles> = {}): NanpaFiles => ({ coCodes: co, cnac, npas: npaText, rateCenters: rcs, ...over });

/** The CO-code file without the line for `npaNxx` (717-464), or with an extra one. */
const without = (text: string, npaNxx: string) =>
  text
    .split('\r\n')
    .filter((l) => !l.includes(`\t${npaNxx}\t`))
    .join('\r\n');
const withExtra = (text: string, line: string) => `${text.replace(/\r\n$/, '')}\r\n${line}\r\n`;
const EXTRA = 'PA   \t717-299\t9208\t"VERIZON PENNSYLVANIA, INC."\tLANCASTER \t\tAS \t\t\tN\tYes      ';

const live = (ctx: TestCtx) => ctx.db.select().from(exchanges).where(isNull(exchanges.withdrawnAt)).all().length;

let ctx: TestCtx;
beforeEach(() => {
  ctx = testCtx();
});

describe('applyNanpa', () => {
  it('fills the tables on the first run', () => {
    const r = applyNanpa(ctx, files());
    expect(r.newExchanges).toBe(46); // 33 US + 13 Canadian
    expect(r).toMatchObject({ withdrawn: 0, restored: 0, newNpas: [] }); // a first import: P5 signs the whole table at setup
    expect(r.rateCenters).toBeGreaterThan(0);
    expect(ctx.db.select().from(exchanges).where(eq(exchanges.npaNxx, '717464')).get()).toMatchObject({
      region: 'PA',
      rateCenter: 'LANCASTER',
      firstSeenAt: ctx.clock.t,
      withdrawnAt: null,
    });
    expect(ctx.db.select().from(npas).where(eq(npas.npa, '717')).get()).toMatchObject({ region: 'PA', geographic: true, inService: true });
    expect(ctx.db.select().from(rateCenters).where(eq(rateCenters.name, 'LANCASTER')).all().map((r) => r.region).sort()).toEqual(['OH', 'PA']);
    const log = ctx.db.select().from(nanpaRefreshes).all();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(true);
    expect(JSON.parse(log[0].detail)).toMatchObject({ newExchanges: 46, errors: [] });
    expect(listAudit(ctx, 1)[0]).toMatchObject({ action: 'nanpa.refresh', actorId: null });
  });

  it('withdraws a code that left the file, counts a new one, and restores one that came back', () => {
    applyNanpa(ctx, files());
    ctx.clock.t += 7 * 86400_000;
    const r2 = applyNanpa(ctx, files({ coCodes: withExtra(without(co, '717-464'), EXTRA) }));
    expect(r2).toMatchObject({ newExchanges: 1, withdrawn: 1, restored: 0 });
    expect(ctx.db.select().from(exchanges).where(eq(exchanges.npaNxx, '717464')).get()?.withdrawnAt).toBe(ctx.clock.t);
    ctx.clock.t += 7 * 86400_000;
    const r3 = applyNanpa(ctx, files({ coCodes: withExtra(co, EXTRA) }));
    expect(r3).toMatchObject({ newExchanges: 0, withdrawn: 0, restored: 1 });
    expect(ctx.db.select().from(exchanges).where(eq(exchanges.npaNxx, '717464')).get()?.withdrawnAt).toBeNull();
  });

  it('refuses a truncated file (under 90 % of the live exchanges) and changes nothing', () => {
    applyNanpa(ctx, files());
    const lines = co.split('\r\n');
    const half = lines.slice(0, Math.ceil(lines.length / 2)).join('\r\n');
    const before = live(ctx);
    expect(() => applyNanpa(ctx, files({ coCodes: half }))).toThrow(/nanpa: .*90 %/);
    expect(live(ctx)).toBe(before);
    expect(ctx.db.select().from(nanpaRefreshes).all()).toHaveLength(1);
  });

  it('a header change fails before anything is written', () => {
    expect(() => applyNanpa(ctx, files({ npas: 'NPA_ID,USE\r\n' }))).toThrow(/unexpected header/);
    expect(ctx.db.select().from(exchanges).all()).toEqual([]);
  });

  it('reports a new geographic NPA (the P5 hook), and only geographic ones', () => {
    // The first run without 220 (Ohio) and 500; the second has both.
    const drop = (t: string, npa: string) => t.split('\r\n').filter((l) => !l.startsWith(`${npa},`)).join('\r\n');
    applyNanpa(ctx, files({ npas: drop(drop(npaText, '220'), '500') }));
    const r = applyNanpa(ctx, files());
    expect(r.newNpas).toEqual(['220']);
  });

  it('leaves the Canadian exchanges alone when the CNAC file is missing, and the rate centers when they are', () => {
    applyNanpa(ctx, files());
    const rcBefore = ctx.db.select().from(rateCenters).all().length;
    const r = applyNanpa(ctx, files({ cnac: undefined, rateCenters: undefined }));
    expect(r).toMatchObject({ withdrawn: 0, rateCenters: 0 });
    expect(live(ctx)).toBe(46);
    expect(ctx.db.select().from(rateCenters).all().length).toBe(rcBefore);
  });
});

describe('fetchNanpa', () => {
  const zip = (name: string, text: string) => zipSync({ [name]: new TextEncoder().encode(text) }) as Uint8Array<ArrayBuffer>;

  function fakeFetch(fail: Set<string> = new Set()) {
    const seen: { url: string; ua: string | null }[] = [];
    const impl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, ua: new Headers(init?.headers).get('user-agent') });
      if (fail.has(url)) return new Response('nope', { status: 503 });
      if (url === NANPA_URLS.coCodes) return new Response(zip('CoCodeAssignment_Utilized_AllStates_Public.txt', co));
      if (url === NANPA_URLS.cnac) return new Response(zip('COCodeStatus_ALL.csv', cnac));
      if (url === NANPA_URLS.npas) return new Response(npaText);
      if (url === NANPA_URLS.lcgRegions) return new Response('<a href="?region=PA">PA</a><a href="?region=QC">QC</a>');
      if (url === `${NANPA_URLS.lcgRc}PA`) return new Response(rcs[0]);
      if (url === `${NANPA_URLS.lcgRc}QC`) return new Response(rcs[2]);
      return new Response('', { status: 404 });
    };
    return { impl: impl as typeof fetch, seen };
  }

  it('downloads, unzips and names itself', async () => {
    const f = fakeFetch();
    const got = await fetchNanpa(NANPA_URLS, f.impl, { delayMs: 0 });
    expect(got.coCodes).toBe(co);
    expect(got.cnac).toBe(cnac);
    expect(got.npas).toBe(npaText);
    expect(got.rateCenters).toEqual([rcs[0], rcs[2]]);
    expect(got.errors).toEqual([]);
    expect(f.seen.every((s) => s.ua === 'OpenCell-portal (opencell@k4ozi.com)')).toBe(true);
    applyNanpa(ctx, got);
    expect(live(ctx)).toBe(46);
  });

  it('skips the rate centers when one region fails, and says so', async () => {
    const got = await fetchNanpa(NANPA_URLS, fakeFetch(new Set([`${NANPA_URLS.lcgRc}QC`])).impl, { delayMs: 0 });
    expect(got.rateCenters).toBeUndefined();
    expect(got.errors?.[0]).toMatch(/rate centers.*QC.*503/);
  });

  it('fails when the CO-code file cannot be fetched', async () => {
    await expect(fetchNanpa(NANPA_URLS, fakeFetch(new Set([NANPA_URLS.coCodes])).impl, { delayMs: 0 })).rejects.toThrow(/503/);
  });
});

describe('oc-portal-admin nanpa-refresh', () => {
  it('--dir reads the files from a directory', async () => {
    const r = await runAdminAsync(ctx, ['nanpa-refresh', '--dir', FIX]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/46 new exchanges, 0 withdrawn, 0 restored, \d+ rate centers/);
    expect(live(ctx)).toBe(46);
    expect(readNanpaDir(FIX).rateCenters).toHaveLength(5);
  });

  it('a failed refresh is logged and exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocp-nanpa-'));
    writeFileSync(join(dir, 'co-codes.txt'), 'nonsense\r\n');
    writeFileSync(join(dir, 'npas.csv'), npaText);
    const r = await runAdminAsync(ctx, ['nanpa-refresh', '--dir', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/unexpected header/);
    const log = ctx.db.select().from(nanpaRefreshes).all();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(false);
  });

  it('does nothing on the NOC site, which holds no numbers', async () => {
    const noc = testCtx({ OC_SITE: 'noc' });
    expect(await runAdminAsync(noc, ['nanpa-refresh', '--dir', FIX])).toMatchObject({ code: 0, out: expect.stringMatching(/nothing to do/) });
    expect(noc.db.select().from(exchanges).all()).toEqual([]);
  });

  it('other commands still run through the async entry', async () => {
    expect((await runAdminAsync(ctx, ['nope'])).code).toBe(2);
  });
});
