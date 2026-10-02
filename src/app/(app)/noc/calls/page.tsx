import type { Metadata } from 'next';
import { RESULT_LABEL } from '@/components/noc/activity';
import { CallTable } from '@/components/noc/call-table';
import { appCtx } from '@/lib/ctx';
import { cachedActivity, RESULTS } from '@/lib/noc/activity';
import { CALLS_PAGES, CALLS_SHOWN, listCalls, parseCallFilter } from '@/lib/noc/calls';
import { cachedSnapshot } from '@/lib/noc/snapshot';
import { requestMeta, requireNoc } from '@/server/request';

export const metadata: Metadata = { title: 'Calls · NOC' };

const SELECT = 'rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900';

/**
 * Every core's calls of the last hour, day or week (plan N2a), filtered by
 * the URL (?core=&window=&result=&cell=&leg=), read under the viewer's own
 * account and audited. No automatic refresh: each view is a read of numbers.
 */
export default async function NocCalls({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requireNoc();
  const ctx = appCtx();
  const f = parseCallFilter(await searchParams);
  const snap = await cachedSnapshot(ctx);
  await cachedActivity(ctx, snap); // where each core's window starts
  const list = await listCalls(ctx, f, user.id, (await requestMeta()).ip);
  const notes = list.cores.flatMap((c) =>
    c.state === 'ok'
      ? c.truncated
        ? [`${c.id}: more than ${CALLS_PAGES * 1000} calls in this window; the oldest are not shown`]
        : []
      : [
          `${c.id}: ${
            c.state === 'unsupported'
              ? 'does not report calls (oc-core before v0.4.0)'
              : c.state === 'not-ready'
                ? 'its calls are not read yet; try again in a minute'
                : 'did not answer in time'
          }`,
        ],
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Calls</h1>
        <p className="text-xs text-slate-500">Read under your account; the portal and the cores record it.</p>
      </div>
      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">Core</span>
          <select name="core" defaultValue={f.core ?? ''} className={SELECT}>
            <option value="">all</option>
            {ctx.cores.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">Ended in the last</span>
          <select name="window" defaultValue={f.window} className={SELECT}>
            <option value="1h">hour</option>
            <option value="24h">24 h</option>
            <option value="7d">7 days</option>
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">Result</span>
          <select name="result" defaultValue={f.result ?? ''} className={SELECT}>
            <option value="">all</option>
            {RESULTS.map((r) => (
              <option key={r} value={r}>
                {RESULT_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">To</span>
          <select name="leg" defaultValue={f.leg ?? ''} className={SELECT}>
            <option value="">anything</option>
            <option value="cell">a cell</option>
            <option value="echo">the echo service</option>
            <option value="playback">the playback service</option>
            <option value="peer">another core</option>
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">Cell id</span>
          <input name="cell" defaultValue={f.cell ?? ''} inputMode="numeric" maxLength={10} className={`${SELECT} w-24`} />
        </label>
        <button type="submit" className="rounded border border-slate-300 px-3 py-1 dark:border-slate-700">
          Filter
        </button>
      </form>
      {notes.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-sm text-amber-700 dark:text-amber-400">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <p className="text-sm text-slate-500">
        {list.matched} {list.matched === 1 ? 'call' : 'calls'}
        {list.matched > CALLS_SHOWN ? `; the newest ${CALLS_SHOWN} are shown` : ''}. A number&apos;s own calls: Number lookup.
      </p>
      <CallTable rows={list.rows} />
    </div>
  );
}
