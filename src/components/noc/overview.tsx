import Link from 'next/link';
import type { Attention, CoreView, NetworkSummary } from '@/lib/noc/snapshot';
import { duration } from '@/lib/noc/format';
import { StatusDot, type Tone } from './status';

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: Tone }) {
  const ring = tone === 'bad' ? 'border-red-500' : tone === 'warn' ? 'border-amber-500' : 'border-slate-300 dark:border-slate-700';
  return (
    <div className={`rounded border p-3 ${ring}`}>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="font-mono text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

/** The overview's headline numbers (NOC design §9.1), all live from the cores that answered. */
export function KpiTiles({ s, children }: { s: NetworkSummary; children?: React.ReactNode }) {
  const coresTone: Tone = s.coresUp === s.coresTotal ? 'ok' : s.coresUp === 0 ? 'bad' : 'warn';
  // Review M5: a core whose cell list did not come is not "all is well" just
  // because the cells that did come are all online.
  const cellsTone: Tone = s.cellsOnline === s.cellsEnabled && !s.cellsUnknown ? 'ok' : 'warn';
  const cellsSub = [s.cellsRevoked > 0 ? `${s.cellsRevoked} revoked, not counted` : null, s.cellsUnknown ? 'cells unknown for some cores' : null]
    .filter((x): x is string => x !== null)
    .join('; ');
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      <Tile label="Cores answering" value={`${s.coresUp} / ${s.coresTotal}`} tone={coresTone} />
      <Tile label="Cells online" value={`${s.cellsOnline} / ${s.cellsEnabled}`} sub={cellsSub || undefined} tone={cellsTone} />
      <Tile label="Terminals registered" value={String(s.terminals)} />
      <Tile label="Calls now" value={String(s.calls)} />
      <Tile label="Subscribers" value={String(s.subscribers)} sub="activated numbers" />
      {children}
    </div>
  );
}

/** One row per core: answering or Unreachable, with what core.status says. */
export function CoreTable({ cores }: { cores: CoreView[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="py-1 pr-4">Core</th>
            <th className="py-1 pr-4">State</th>
            <th className="py-1 pr-4">Name</th>
            <th className="py-1 pr-4">Version</th>
            <th className="py-1 pr-4">Up</th>
            <th className="py-1 pr-4 text-right">Cells</th>
            <th className="py-1 pr-4 text-right">Subscribers</th>
            <th className="py-1 text-right">Calls</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {cores.map((c) => (
            <tr key={c.id} className="border-b border-slate-100 dark:border-slate-900">
              <td className="py-1 pr-4">
                <Link href={`/noc/cores/${c.id}`} prefetch={false} className="text-brand underline">
                  {c.id}
                </Link>{' '}
                <span className="text-xs text-slate-500">{c.where}</span>
              </td>
              <td className="py-1 pr-4 font-sans">
                {c.status ? <StatusDot tone="ok" label="Answering" /> : <StatusDot tone="bad" label="Unreachable" />}
              </td>
              <td className="py-1 pr-4">{c.status?.name ?? '—'}</td>
              <td className="py-1 pr-4">{c.status?.version ?? '—'}</td>
              <td className="py-1 pr-4">{c.status ? duration(c.status.uptimeS) : '—'}</td>
              <td className="py-1 pr-4 text-right">{c.status ? `${c.status.cellsOnline} / ${c.status.cellsTotal}` : '—'}</td>
              <td className="py-1 pr-4 text-right">{c.status?.subscribers ?? '—'}</td>
              <td className="py-1 text-right">{c.status?.callsNow ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SEV: Record<Attention['severity'], { tone: Tone; label: string }> = {
  critical: { tone: 'bad', label: 'Critical' },
  warning: { tone: 'warn', label: 'Warning' },
  info: { tone: 'info', label: 'Info' },
};

/** "Needs attention": derived from this snapshot only; N1 keeps no alarms (NOC design §6). */
export function AttentionList({ items }: { items: Attention[] }) {
  if (items.length === 0) return <p className="text-sm text-slate-500">Nothing needs attention.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {items.map((a, i) => (
        <li key={`${a.core}-${a.cellId ?? ''}-${i}`} className="flex flex-wrap gap-x-3">
          <StatusDot tone={SEV[a.severity].tone} label={SEV[a.severity].label} />
          {a.cellId !== undefined ? (
            <Link href={`/noc/cells/${a.core}/${a.cellId}`} prefetch={false} className="underline">
              {a.text}
            </Link>
          ) : (
            <span>{a.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * What the NOC cannot show yet, and why (NOC design §5.2; plan N2a shows the
 * rest): each needs a later plan. Shown, not hidden, so nobody reads an
 * empty panel as "all is well".
 */
export const NOT_REPORTED: { what: string; why: string }[] = [
  { what: 'Voice quality (frames sent, received, lost and concealed), call setup time', why: 'needs CALL_STATS from the cell and a CDR schema change (core telemetry phase 2)' },
  { what: 'Rates and trends (late slots per hour, calls per hour), history', why: 'need the portal on PostgreSQL (plan (b)), then N2' },
  { what: 'Database layer (Patroni, replication, backups, drills)', why: 'needs the DatabaseStatus adapter (plan N4)' },
  { what: 'Alarms with acknowledgement, history, downtime windows, jobs', why: 'need the portal on PostgreSQL (plan (b)), then N2' },
  { what: 'Admin-API certificate expiry', why: 'N2: read from the TLS session' },
];

export function NotReported() {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
      {NOT_REPORTED.map((n) => (
        <li key={n.what}>
          {n.what}: <span className="text-slate-500">{n.why}</span>
        </li>
      ))}
    </ul>
  );
}
