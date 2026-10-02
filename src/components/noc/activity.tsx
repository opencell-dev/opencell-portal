import Link from 'next/link';
import { CAUSES } from '@/core/wire-noc';
import { type ActivitySummary, type CallStats, RESULTS } from '@/lib/noc/activity';

// The last day's calls and registrations (plan N2a), from the shared
// activity: totals only, no numbers.

export const RESULT_LABEL: Record<(typeof RESULTS)[number], string> = {
  answered: 'answered',
  no_answer: 'no answer',
  busy: 'busy',
  unreachable: 'unreachable',
  failed: 'failed',
};

export function pct(n: number, of: number): string {
  return of === 0 ? '—' : `${Math.round((n / of) * 100)} %`;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-slate-300 p-3 dark:border-slate-700">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="font-mono text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function note(a: ActivitySummary): string | undefined {
  const parts = [a.missing.length > 0 ? `not from ${a.missing.join(', ')}` : null, a.catchingUp ? 'still counting' : null].filter(
    (x): x is string => x !== null,
  );
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/** "Calls, last 24 h" and "Registrations, last 24 h", beside the overview's live tiles. */
export function ActivityTiles({ a }: { a: ActivitySummary }) {
  const n = note(a);
  return (
    <>
      <Tile
        label="Calls, last 24 h"
        value={a.calls ? String(a.calls.total) : '—'}
        sub={a.calls ? [`${pct(a.calls.answered, a.calls.total)} answered`, n].filter(Boolean).join('; ') : 'not reported by the cores'}
      />
      <Tile label="Registrations, last 24 h" value={a.registrations === null ? '—' : String(a.registrations)} sub={a.registrations === null ? 'not reported by the cores' : n} />
    </>
  );
}

/** How the last day's calls ended: by result, and by the core's release cause. */
export function CallMix({ s }: { s: CallStats | null }) {
  if (!s) return <p className="text-sm text-slate-500">No core reported its calls (cdr.recent needs oc-core v0.4.0).</p>;
  if (s.total === 0) return <p className="text-sm text-slate-500">No calls ended in the last 24 h.</p>;
  const causes = Object.entries(s.byCause)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((x, y) => y[1] - x[1]);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="py-1 pr-4">Result</th>
            <th className="py-1 pr-4 text-right">Calls</th>
            <th className="py-1 text-right">Share</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {RESULTS.map((r) => (
            <tr key={r} className="border-b border-slate-100 dark:border-slate-900">
              <td className="py-1 pr-4">
                <Link href={`/noc/calls?result=${r}`} prefetch={false} className="underline">
                  {RESULT_LABEL[r]}
                </Link>
              </td>
              <td className="py-1 pr-4 text-right font-mono">{s.byResult[r]}</td>
              <td className="py-1 text-right font-mono">{pct(s.byResult[r], s.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="py-1 pr-4">End cause (core)</th>
            <th className="py-1 text-right">Calls</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {causes.map(([k, v]) => (
            <tr key={k} className="border-b border-slate-100 dark:border-slate-900">
              <td className="py-1 pr-4">
                {CAUSES[k] ?? 'other'} <span className="text-xs text-slate-500">({k})</span>
              </td>
              <td className="py-1 text-right font-mono">{v}</td>
            </tr>
          ))}
          <tr>
            <td className="py-1 pr-4 text-xs text-slate-500" colSpan={2}>
              To the echo service {s.byLeg.echo}, playback {s.byLeg.playback}, another core {s.byLeg.peer}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
