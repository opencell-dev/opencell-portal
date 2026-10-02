import type { Metadata } from 'next';
import { AutoRefresh } from '@/components/noc/auto-refresh';
import { CellTable } from '@/components/noc/cell-table';
import { When } from '@/components/noc/status';
import { appCtx } from '@/lib/ctx';
import { CELL_STATES, filterCells, parseCellFilter } from '@/lib/noc/cell-filter';
import { allCells, cachedSnapshot } from '@/lib/noc/snapshot';
import { requireNoc } from '@/server/request';

export const metadata: Metadata = { title: 'Cells · NOC' };

const SELECT = 'rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900';

/** Every cell on every core (NOC design §9.4), filtered by the URL: ?core=&state=&mode=&q=. */
export default async function NocCells({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireNoc();
  const ctx = appCtx();
  const f = parseCellFilter(await searchParams);
  const snap = await cachedSnapshot(ctx);
  const cells = filterCells(allCells(snap), f);
  const silent = snap.cores.filter((c) => c.cells === null).map((c) => c.id);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Cells</h1>
        <p className="flex items-center gap-3 text-xs text-slate-500">
          <span>
            Asked <When t={snap.at} now={ctx.now()} />
          </span>
          <AutoRefresh />
        </p>
      </div>
      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">Core</span>
          <select name="core" defaultValue={f.core ?? ''} className={SELECT}>
            <option value="">all</option>
            {snap.cores.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">State</span>
          <select name="state" defaultValue={f.state ?? ''} className={SELECT}>
            <option value="">all</option>
            {CELL_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">Mode</span>
          <select name="mode" defaultValue={f.mode ?? ''} className={SELECT}>
            <option value="">all</option>
            <option value="part15">Part 15</option>
            <option value="part97">Part 97</option>
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">Name or id</span>
          <input name="q" defaultValue={f.q ?? ''} maxLength={32} className={SELECT} />
        </label>
        <button type="submit" className="rounded border border-slate-300 px-3 py-1 dark:border-slate-700">
          Filter
        </button>
      </form>
      {silent.length > 0 && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          No cell list from {silent.join(', ')}: its cells are not shown.
        </p>
      )}
      <CellTable cells={cells} now={ctx.now()} />
    </div>
  );
}
