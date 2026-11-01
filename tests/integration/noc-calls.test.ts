import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CallTable } from '@/components/noc/call-table';
import { seedDemo } from '@/core/fake-demo';
import { CoreError } from '@/core/types';
import { listAudit } from '@/lib/audit';
import { ACTIVITY_TTL_MS, cachedActivity, callResult, DAY_MS } from '@/lib/noc/activity';
import { CALLS_PAGES, CALLS_SHOWN, getCall, listCalls, parseCallFilter } from '@/lib/noc/calls';
import { cachedSnapshot } from '@/lib/noc/snapshot';
import { testCtx } from '../helpers/ctx';

// The Calls page's reads (plan N2a): under the viewer's own account, from
// where the shared activity says the window starts, filtered, audited.

async function demo() {
  const ctx = testCtx({ OC_SITE: 'noc' });
  seedDemo(ctx.core, 0, ctx.now());
  await cachedActivity(ctx, await cachedSnapshot(ctx));
  return ctx;
}

const all = async (ctx: Awaited<ReturnType<typeof demo>>) => {
  const a = await ctx.core.cdrRecent(0, 0, 1000);
  return [...a, ...(await ctx.core.cdrRecent(0, a.at(-1)!.id, 1000))];
};

describe('listCalls', () => {
  it("lists the day's calls newest first, read as the viewer from the window's start, and audits the view", async () => {
    const ctx = await demo();
    const spy = vi.spyOn(ctx.core, 'cdrRecent');
    const list = await listCalls(ctx, parseCallFilter({}), 42, '192.0.2.7');
    const day = (await all(ctx)).filter((c) => c.endAt >= ctx.now() - DAY_MS);
    expect(list.matched).toBe(day.length);
    expect(list.rows.length).toBe(Math.min(day.length, CALLS_SHOWN));
    for (let i = 1; i < list.rows.length; i++) expect(list.rows[i].endAt).toBeLessThanOrEqual(list.rows[i - 1].endAt);
    expect(list.cores).toEqual([{ id: 'fake', state: 'ok', truncated: false }]);
    expect(spy.mock.calls[0][0]).toBe(1_000_042);
    expect(spy.mock.calls[0][1]).toBeGreaterThan(0); // not from the first record: from the window's start
    expect(listAudit(ctx, 1)[0]).toMatchObject({
      actorId: 42,
      action: 'noc.calls',
      target: 'core:all',
      detail: JSON.stringify({ window: '24h', result: null, cell: null, leg: null, matched: day.length }),
    });
  });

  it('filters by window, result, cell and called leg', async () => {
    const ctx = await demo();
    const every = await all(ctx);
    const week = await listCalls(ctx, parseCallFilter({ window: '7d', result: 'busy' }), 42, 'ip');
    expect(week.matched).toBe(every.filter((c) => callResult(c) === 'busy').length);
    const echo = await listCalls(ctx, parseCallFilter({ window: '7d', leg: 'echo' }), 42, 'ip');
    expect(echo.rows.every((c) => c.legB === 'echo' && c.cellB === null)).toBe(true);
    const cell = every[0].cellA!;
    const one = await listCalls(ctx, parseCallFilter({ window: '7d', cell: String(cell) }), 42, 'ip');
    expect(one.matched).toBe(every.filter((c) => c.cellA === cell || c.cellB === cell).length);
  });

  it('ignores filters that do not parse', () => {
    expect(parseCallFilter({ window: 'forever', result: 'great', cell: '-3', leg: 'moon', core: 'Core 1!' })).toEqual({ window: '24h' });
    expect(parseCallFilter({ window: ['1h', '7d'], cell: '12' })).toEqual({ window: '1h', cell: 12 });
  });

  it("says a core's window is not known yet, or that it is too old or silent", async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    expect((await listCalls(ctx, parseCallFilter({}), 42, 'ip')).cores).toEqual([{ id: 'fake', state: 'not-ready', truncated: false }]);
    await cachedActivity(ctx, await cachedSnapshot(ctx));
    vi.spyOn(ctx.core, 'cdrRecent').mockRejectedValueOnce(new CoreError('unsupported'));
    expect((await listCalls(ctx, parseCallFilter({}), 42, 'ip')).cores[0].state).toBe('unsupported');
  });

  it('shows the newest calls, not the oldest, when a window holds more than CALLS_PAGES pages (review I1)', async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    const base = ctx.now() - 200_000;
    const total = CALLS_PAGES * 1000 + 1500; // 6500: more than one core's view can read in one go
    for (let i = 0; i < total; i++) {
      ctx.core.simCdr({
        setupAt: base + i,
        answerAt: base + i + 1,
        endAt: base + i + 2,
        cause: 0,
        caller: '+883171746412345',
        called: '+883171746400777',
        cellA: 1,
        cellB: 1,
        legA: 'cell',
        legB: 'cell',
      });
    }
    // Seed the shared tail across two refreshes, so it holds every id of the window without numbers.
    await cachedActivity(ctx, await cachedSnapshot(ctx));
    ctx.clock.t += ACTIVITY_TTL_MS;
    await cachedActivity(ctx, await cachedSnapshot(ctx));
    const list = await listCalls(ctx, parseCallFilter({ window: '1h' }), 42, 'ip');
    expect(list.cores[0]).toMatchObject({ truncated: true });
    expect(Math.max(...list.rows.map((r) => r.id))).toBe(total);
    expect(Math.min(...list.rows.map((r) => r.id))).toBeGreaterThan(total - CALLS_SHOWN);
  });
});

describe('getCall', () => {
  it('reads one record by its id, as the viewer, and audits it; null for no such record', async () => {
    const ctx = await demo();
    const [first] = await ctx.core.cdrRecent(0, 0, 1);
    const spy = vi.spyOn(ctx.core, 'cdrRecent');
    expect(await getCall(ctx, 'fake', first.id, 42, 'ip')).toEqual({ ...first, core: 'fake' });
    expect(spy).toHaveBeenCalledWith(1_000_042, first.id - 1, 1);
    expect(listAudit(ctx, 1)[0]).toMatchObject({ action: 'noc.call', target: `cdr:fake/${first.id}`, detail: '{"core":"fake","found":true}' });
    expect(await getCall(ctx, 'fake', 4_000_000, 42, 'ip')).toBeNull();
    expect(await getCall(ctx, 'nope', 1, 42, 'ip')).toBeNull();
  });
});

describe('the call list', () => {
  it('shows each call with its numbers, legs, ring and talk time, result and cause, linking to it and its cells', async () => {
    const ctx = await demo();
    const list = await listCalls(ctx, parseCallFilter({ window: '7d', leg: 'echo' }), 42, 'ip');
    const c = list.rows[0];
    const out = renderToStaticMarkup(createElement(CallTable, { rows: [c] }));
    expect(out).toContain(`href="/noc/calls/fake/${c.id}"`);
    expect(out).toContain(`href="/noc/cells/fake/${c.cellA}"`);
    expect(out).toMatch(/echo service.*answered.*normal/s);
    expect(renderToStaticMarkup(createElement(CallTable, { rows: [] }))).toContain('No calls match.');
  });
});
