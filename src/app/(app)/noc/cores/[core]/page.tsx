import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CellTable } from '@/components/noc/cell-table';
import { StatusDot, When } from '@/components/noc/status';
import { appCtx } from '@/lib/ctx';
import { duration } from '@/lib/noc/format';
import { cachedSnapshot } from '@/lib/noc/snapshot';
import { requireNoc } from '@/server/request';

export const metadata: Metadata = { title: 'Core · NOC' };

/** One core (NOC design §9.3): core.status and its cells. */
export default async function NocCore({ params }: { params: Promise<{ core: string }> }) {
  await requireNoc();
  const ctx = appCtx();
  const { core } = await params;
  const snap = await cachedSnapshot(ctx);
  const view = snap.cores.find((c) => c.id === core);
  if (!view) notFound();
  const now = ctx.now();
  const st = view.status;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">
          {view.id} <span className="font-mono text-sm font-normal text-slate-500">{view.where}</span>
        </h1>
        {st ? <StatusDot tone="ok" label="Answering" /> : <StatusDot tone="bad" label={`Unreachable (no answer within ${snap.deadlineMs / 1000} s)`} />}
      </div>
      {st && (
        <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-slate-500">Core id</dt>
          <dd className="font-mono">{st.coreId}</dd>
          <dt className="text-slate-500">Name</dt>
          <dd>{st.name}</dd>
          <dt className="text-slate-500">Version</dt>
          <dd className="font-mono">{st.version}</dd>
          <dt className="text-slate-500">Up for</dt>
          <dd>{duration(st.uptimeS)}</dd>
          <dt className="text-slate-500">Cells linked</dt>
          <dd className="font-mono">
            {st.cellsOnline} / {st.cellsTotal}
          </dd>
          <dt className="text-slate-500">Activated subscribers</dt>
          <dd className="font-mono">{st.subscribers}</dd>
          <dt className="text-slate-500">Calls now</dt>
          <dd className="font-mono">{st.callsNow}</dd>
          <dt className="text-slate-500">Asked</dt>
          <dd>
            <When t={snap.at} now={now} />
          </dd>
        </dl>
      )}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Cells</h2>
        {view.cells ? (
          <CellTable cells={view.cells.map((c) => ({ ...c, core: view.id }))} now={now} />
        ) : (
          <p className="text-sm text-red-700 dark:text-red-400">No cell list from {view.id}.</p>
        )}
      </section>
      <section className="space-y-1">
        <h2 className="text-lg font-semibold">Not reported yet</h2>
        <ul className="list-disc pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>Blocks this core is home for: core.blocks (core plan)</li>
          <li>OCSS peers and link state: ocss.status (core plan)</li>
          <li>The core&apos;s own admin audit: audit.list (core plan)</li>
          <li>Admin-API certificate expiry, database cluster state: N4 adapters</li>
        </ul>
      </section>
    </div>
  );
}
