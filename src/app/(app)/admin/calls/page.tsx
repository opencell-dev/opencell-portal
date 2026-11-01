import type { Metadata } from 'next';
import Link from 'next/link';
import { CallTable } from '@/components/noc/call-table';
import { appCtx } from '@/lib/ctx';
import { cachedActivity } from '@/lib/noc/activity';
import { listCalls, parseCallFilter } from '@/lib/noc/calls';
import { cachedSnapshot } from '@/lib/noc/snapshot';
import { requestMeta, requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Call records' };

const SELECT = 'rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900';

/** Every core's call records (portal spec §1, §10: the parties' owners and admins), read under the admin's account and audited. */
export default async function AdminCalls({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requireAdmin();
  const ctx = appCtx();
  const f = parseCallFilter(await searchParams);
  await cachedActivity(ctx, await cachedSnapshot(ctx)); // where each core's window starts
  const list = await listCalls(ctx, f, user.id, (await requestMeta()).ip);
  return (
    <div className="space-y-4">
      <p>
        <Link href="/admin" className="text-sm underline">
          ← Admin
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Call records</h1>
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
        <button type="submit" className="rounded border border-slate-300 px-3 py-1 dark:border-slate-700">
          Show
        </button>
      </form>
      {list.cores
        .filter((c) => c.state !== 'ok')
        .map((c) => (
          <p key={c.id} role="status" className="text-sm">
            {c.id}: {c.state === 'unsupported' ? 'does not report calls' : c.state === 'not-ready' ? 'its calls are not read yet; try again in a minute' : 'did not answer in time'}
          </p>
        ))}
      <p className="text-sm text-slate-500">{list.matched} matched.</p>
      <CallTable rows={list.rows} linked={false} />
    </div>
  );
}
