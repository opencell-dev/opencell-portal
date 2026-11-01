import type { Metadata } from 'next';
import Link from 'next/link';
import { NpaOverrideForm } from '@/components/admin/cell-controls';
import { coreBlocksAll, npaTable, overrideCommand, refreshLog, wantedHomes } from '@/lib/admin/blocks';
import { appCtx } from '@/lib/ctx';
import { blocksKnown, refreshBlocks } from '@/lib/numbers/blocks';
import { sideLabel } from '@/lib/numbers/homing';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Numbers and blocks' };

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');

/** The NPA → core table (portal spec §4.3), each core's blocks, and the NANPA refresh log. */
export default async function AdminNumbers({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requireAdmin();
  const ctx = appCtx();
  if (!blocksKnown(ctx)) await refreshBlocks(ctx);
  const q = one((await searchParams).q);
  const rows = npaTable(ctx, q);
  const [blocks, command] = await Promise.all([coreBlocksAll(ctx, user.id), overrideCommand(ctx, user.id, wantedHomes(ctx))]);
  const refreshes = refreshLog(ctx);
  return (
    <div className="space-y-8">
      <p>
        <Link href="/admin" className="text-sm underline">
          ← Admin
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Numbers and blocks</h1>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Move an area code to another core</h2>
        <p className="max-w-2xl text-sm">
          A block&apos;s home is a routing-table change, signed offline with the root key. Noting a home here changes no routing: it prints the command to run on the laptop, and shows as done once the cores report it.
        </p>
        <NpaOverrideForm cores={ctx.cores.map((h) => h.coreNo)} />
        {command && (
          <div className="space-y-1">
            <p className="text-sm font-medium">On the laptop:</p>
            <code className="block overflow-x-auto whitespace-pre rounded bg-slate-100 p-2 font-mono text-xs dark:bg-slate-900" data-testid="override-command">
              {command}
            </code>
            <p className="text-sm text-slate-500">Then copy the new table to every core and restart them. List every earlier addition in npa.csv with its index (--pin NPA=IDX): the runbook is in deploy/oc-portal-route-delegate.conf.</p>
          </div>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Each core</h2>
        <ul className="text-sm">
          {blocks.map((b) => (
            <li key={b.coreId}>
              {b.coreId}: {Array.isArray(b.blocks) ? `${b.blocks.length} blocks, home for ${b.blocks.filter((x) => x.role === 'home').length}` : b.blocks === 'unsupported' ? 'does not report blocks' : "didn't answer"}
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">NANPA refreshes</h2>
        {refreshes.length === 0 ? (
          <p className="text-sm">None yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {refreshes.map((r) => (
              <li key={r.id}>
                {new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')} UTC: {r.summary}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Area codes</h2>
        <form method="get" className="flex max-w-md items-end gap-2">
          <label className="flex-1 text-sm">
            <span className="font-medium">Area code or state</span>
            <input name="q" defaultValue={q} maxLength={32} className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <button type="submit" className="rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
            Search
          </button>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="py-2 pr-4">NPA</th>
                <th className="py-2 pr-4">Region</th>
                <th className="py-2 pr-4">State code</th>
                <th className="py-2 pr-4">Home core</th>
                <th className="py-2 pr-4">State rule</th>
                <th className="py-2 pr-4">Wanted</th>
                <th className="py-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.npa} className="border-b border-slate-100 dark:border-slate-900" data-testid="npa-row">
                  <td className="py-1 pr-4 font-mono">{r.npa}</td>
                  <td className="py-1 pr-4">{r.region || '—'}</td>
                  <td className="py-1 pr-4">{r.stateCode ?? '—'}</td>
                  <td className="py-1 pr-4">{r.home === null ? '—' : `Core ${r.home}`}</td>
                  <td className="py-1 pr-4">{r.ruleSide ? sideLabel(r.ruleSide) : '—'}</td>
                  <td className="py-1 pr-4">{r.overrideWanted === null ? '—' : `Core ${r.overrideWanted}${r.overrideDone ? ' (done)' : ''}`}</td>
                  <td className="py-1">
                    {!r.geographic ? 'Not geographic' : !r.inService ? 'Not in service' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
