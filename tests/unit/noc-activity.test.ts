import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeCore } from '@/core/fake';
import { seedDemo } from '@/core/fake-demo';
import { CoreError, type CoreHandle } from '@/core/types';
import {
  auditEnd,
  cachedActivity,
  callResult,
  callRows,
  callsAfter,
  callStats,
  DAY_MS,
  forgetActivity,
  networkActivity,
} from '@/lib/noc/activity';
import { networkSnapshot } from '@/lib/noc/snapshot';
import { testCtx } from '../helpers/ctx';

// Plan N2a: the calls and registrations of the last day, from each core's
// call records and audit, read as the portal itself and kept without numbers.

afterEach(() => vi.restoreAllMocks());

function demoCtx() {
  const ctx = testCtx();
  seedDemo(ctx.core, 0, ctx.now());
  return ctx;
}

describe('the network activity (plan N2a)', () => {
  it("counts the last day's calls by result, cause and called leg, as cdr.recent says", async () => {
    const ctx = demoCtx();
    const a = await networkActivity(ctx, await networkSnapshot(ctx));
    const all = await ctx.core.cdrRecent(0, 0, 1000);
    const more = await ctx.core.cdrRecent(0, all.at(-1)!.id, 1000);
    const day = [...all, ...more].filter((c) => c.endAt >= ctx.now() - DAY_MS);
    expect(a.cores[0].calls).toMatchObject({ state: 'ok', complete: true });
    if (a.cores[0].calls.state !== 'ok') throw new Error('no calls');
    const s = a.cores[0].calls.value;
    expect(s.total).toBe(day.length);
    expect(s.answered).toBe(day.filter((c) => c.answerAt !== null).length);
    expect(s.byResult.answered + s.byResult.no_answer + s.byResult.busy + s.byResult.unreachable + s.byResult.failed).toBe(s.total);
    expect(s.byLeg.echo).toBe(day.filter((c) => c.legB === 'echo').length);
  });

  it("counts the last day's registrations, by cell", async () => {
    const ctx = demoCtx();
    const a = await networkActivity(ctx, await networkSnapshot(ctx));
    const reg = (await ctx.core.auditList(0, { events: [3], limit: 500 })).filter((r) => r.at >= ctx.now() - DAY_MS);
    expect(a.cores[0].registrations).toMatchObject({ state: 'ok', value: { total: reg.length } });
    if (a.cores[0].registrations.state !== 'ok') throw new Error('no registrations');
    const byCell = a.cores[0].registrations.value.byCell;
    expect(Object.values(byCell).reduce((x, y) => x + y, 0)).toBe(reg.length);
  });

  it('asks as the portal itself, and keeps no numbers in what it shares', async () => {
    const ctx = demoCtx();
    const cdr = vi.spyOn(ctx.core, 'cdrRecent');
    const audit = vi.spyOn(ctx.core, 'auditList');
    await networkActivity(ctx, await networkSnapshot(ctx));
    for (const c of [...cdr.mock.calls, ...audit.mock.calls]) expect(c[0]).toBe(0);
    expect(audit.mock.calls.every(([, q]) => q.number === undefined)).toBe(true);
    // What the activity holds for the pages: ids, times, causes and cells, no numbers.
    const after = callsAfter(ctx, 'fake', ctx.now() - DAY_MS);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(auditEnd(ctx, 'fake')).toBeGreaterThan(0);
    const rows = callRows(ctx, 'fake') ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => 'caller' in r || 'called' in r)).toBe(false);
  });

  it('reads only what is new on the next minute, and shares one reading for a minute', async () => {
    const ctx = demoCtx();
    const snap = await networkSnapshot(ctx);
    const first = await cachedActivity(ctx, snap);
    expect(await cachedActivity(ctx, snap)).toBe(first);
    const cdr = vi.spyOn(ctx.core, 'cdrRecent');
    ctx.clock.t += 61_000;
    ctx.core.simCdr({
      setupAt: ctx.now() - 30_000,
      answerAt: null,
      endAt: ctx.now() - 1000,
      cause: 2,
      caller: '+883171746412345',
      called: '+883171746454321',
      cellA: 1,
      cellB: 2,
      legA: 'cell',
      legB: 'cell',
    });
    const next = await cachedActivity(ctx, snap);
    expect(next).not.toBe(first);
    expect(cdr).toHaveBeenCalledTimes(1);
    if (next.cores[0].calls.state !== 'ok' || first.cores[0].calls.state !== 'ok') throw new Error('no calls');
    expect(next.cores[0].calls.value.byResult.busy).toBe(first.cores[0].calls.value.byResult.busy + 1);
  });

  it('does not ask a core the snapshot found unreachable; says when one fails or lacks the operations', async () => {
    const ctx = testCtx();
    const old = new FakeCore(ctx.now, { coreId: 2 });
    const cores: CoreHandle[] = [ctx.cores[0], { id: 'core2', where: 'x', core: old }];
    const two = { ...ctx, cores };
    vi.spyOn(old, 'cdrRecent').mockRejectedValue(new CoreError('unsupported'));
    vi.spyOn(old, 'auditList').mockRejectedValue(new CoreError('unsupported'));
    const snap = await networkSnapshot(two);
    const a = await networkActivity(two, { ...snap, cores: [{ ...snap.cores[0], status: null }, snap.cores[1]] });
    expect(a.cores.map((c) => [c.id, c.calls.state, c.registrations.state])).toEqual([
      ['fake', 'unreachable', 'unreachable'],
      ['core2', 'unsupported', 'unsupported'],
    ]);
  });

  it('starts again after forgetActivity (the demo network reloaded)', async () => {
    const ctx = demoCtx();
    const snap = await networkSnapshot(ctx);
    const first = await cachedActivity(ctx, snap);
    forgetActivity(ctx);
    expect(callsAfter(ctx, 'fake', 0)).toBeNull();
    expect(await cachedActivity(ctx, snap)).not.toBe(first);
  });
});

describe('callStats and callResult', () => {
  const row = (o: Partial<Parameters<typeof callStats>[0][number]>) => ({
    id: 1,
    t: 1000,
    setupAt: 0,
    answerAt: 500 as number | null,
    endAt: 1000,
    cause: 0,
    cellA: 1 as number | null,
    cellB: 2 as number | null,
    legA: 'cell' as const,
    legB: 'cell' as const,
    ...o,
  });

  it("reads a record's result as cdr.list does", () => {
    expect(callResult({ answerAt: 5, cause: 0 })).toBe('answered');
    expect(callResult({ answerAt: null, cause: 2 })).toBe('busy');
    expect(callResult({ answerAt: null, cause: 6 })).toBe('failed');
  });

  it('counts only the window, and with a cell only the calls with a leg on it', () => {
    const rows = [row({ id: 1, t: 1000 }), row({ id: 2, t: 5000, cellA: 3, cellB: null, legB: 'echo' }), row({ id: 3, t: 9000, answerAt: null, cause: 3 })];
    expect(callStats(rows, 9000, 5000)).toMatchObject({ total: 2, answered: 1, byResult: { no_answer: 1 }, byLeg: { echo: 1, cell: 1 } });
    expect(callStats(rows, 9000, 10_000, 3).total).toBe(1);
    expect(callStats(rows, 9000, 10_000, 2).total).toBe(2);
  });
});
