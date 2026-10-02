import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pct } from '@/components/noc/activity';
import { RadioPanel } from '@/components/noc/radio-panel';
import { cellTone, StatusDot, When } from '@/components/noc/status';
import { TerminalTable } from '@/components/noc/terminal-table';
import { appCtx } from '@/lib/ctx';
import { cachedActivity, callRows, callStats } from '@/lib/noc/activity';
import { modeLabel } from '@/lib/noc/format';
import { registrationsPage } from '@/lib/noc/registrations';
import { cachedSnapshot } from '@/lib/noc/snapshot';
import { requestMeta, requireNoc } from '@/server/request';

export const metadata: Metadata = { title: 'Cell · NOC' };

/**
 * One cell (NOC design §9.4): what cell.status says; its radio health
 * (cell.radio) and the last day's calls and registrations on it, from the
 * shared snapshot and activity; and its terminals with their signal
 * (reg.list), read as this staff member and audited (plan N2a).
 */
export default async function NocCell({ params }: { params: Promise<{ core: string; cell: string }> }) {
  const { user } = await requireNoc();
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
  const activity = await cachedActivity(ctx, snap);
  const rows = callRows(ctx, core);
  const calls = rows ? callStats(rows, now, 86400_000, c.cellId) : null;
  const regs = activity.cores.find((a) => a.id === core)?.registrations;
  const terms = c.revoked ? null : await registrationsPage(ctx, { core, cellId: c.cellId }, user.id, (await requestMeta()).ip);
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
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Radio</h2>
        <RadioPanel radio={view.radio} cellId={c.cellId} online={c.online} now={now} />
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Last 24 h</h2>
        <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-slate-500">Calls with a leg here</dt>
          <dd className="font-mono">{calls ? `${calls.total} (${pct(calls.answered, calls.total)} answered)` : 'not reported'}</dd>
          <dt className="text-slate-500">Registrations</dt>
          <dd className="font-mono">{regs?.state === 'ok' ? (regs.value.byCell[c.cellId] ?? 0) : 'not reported'}</dd>
        </dl>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Terminals registered here</h2>
        <p className="text-xs text-slate-500">Read under your account; the portal and the core record it.</p>
        {terms === null ? (
          <p className="text-sm text-slate-500">A revoked cell has no terminals.</p>
        ) : terms.rows.state === 'ok' ? (
          <TerminalTable rows={terms.rows.value} now={now} core={core} showCell={false} />
        ) : terms.rows.state === 'unsupported' ? (
          <p className="text-sm text-slate-500">Not reported by this core (reg.list needs oc-core v0.4.0).</p>
        ) : (
          <p className="text-sm text-red-700 dark:text-red-400">{core} did not list them in time.</p>
        )}
      </section>
    </div>
  );
}
