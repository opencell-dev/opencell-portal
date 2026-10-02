import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cellTone, StatusDot, When } from '@/components/noc/status';
import { appCtx } from '@/lib/ctx';
import { modeLabel } from '@/lib/noc/format';
import { cachedSnapshot } from '@/lib/noc/snapshot';
import { requireNoc } from '@/server/request';

export const metadata: Metadata = { title: 'Cell · NOC' };

/** One cell (NOC design §9.4): what cell.status says, and what N1 cannot say yet. */
export default async function NocCell({ params }: { params: Promise<{ core: string; cell: string }> }) {
  await requireNoc();
  const ctx = appCtx();
  const { core, cell } = await params;
  if (!/^[1-9]\d{0,9}$/.test(cell)) notFound();
  const snap = await cachedSnapshot(ctx);
  const view = snap.cores.find((c) => c.id === core);
  if (!view) notFound();
  const c = view.cells?.find((x) => x.cellId === Number(cell));
  if (!c) {
    if (view.cells === null) {
      return (
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">
            Cell {cell} on {core}
          </h1>
          <p role="alert" className="text-red-700 dark:text-red-400">
            {core} did not answer within {snap.deadlineMs / 1000} s: this cell can&apos;t be shown now.
          </p>
        </div>
      );
    }
    notFound();
  }
  const st = cellTone(c);
  const now = ctx.now();
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm">
          <Link href={`/noc/cores/${core}`} prefetch={false} className="text-brand underline">
            {core}
          </Link>{' '}
          / cell {c.cellId}
        </p>
        <h1 className="text-2xl font-semibold">{c.name}</h1>
        <StatusDot tone={st.tone} label={st.label} />
      </div>
      <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-slate-500">Mode</dt>
        <dd>{modeLabel(c.mode)}</dd>
        <dt className="text-slate-500">Channel-list group</dt>
        <dd className="font-mono">{c.group}</dd>
        <dt className="text-slate-500">Last HELLO</dt>
        <dd>
          <When t={c.lastHeardAt} now={now} />
        </dd>
        <dt className="text-slate-500">Terminals registered</dt>
        <dd className="font-mono">{c.terminals}</dd>
        <dt className="text-slate-500">Calls now</dt>
        <dd className="font-mono">{c.calls}</dd>
        <dt className="text-slate-500">Certificate (SHA-256)</dt>
        <dd className="break-all font-mono text-xs">{c.certFpr ?? 'none pinned'}</dd>
        <dt className="text-slate-500">Asked</dt>
        <dd>
          <When t={snap.at} now={now} />
        </dd>
      </dl>
      <section className="space-y-1">
        <h2 className="text-lg font-semibold">Not reported yet</h2>
        <ul className="list-disc pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>Radios on this cell, their STATUS counters, channel, anchor and PPS / GPS lock: cell.radio (core plan)</li>
          <li>Which terminals are registered here, with signal: reg.list (core plan)</li>
          <li>Downtime windows, history and alerts: N2, after the portal moves to PostgreSQL</li>
          <li>Mode switch, certificate revoke and re-issue: N2 (jobs, audited and confirmed)</li>
        </ul>
      </section>
    </div>
  );
}
