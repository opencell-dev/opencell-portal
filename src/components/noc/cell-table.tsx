import Link from 'next/link';
import { modeLabel, shortFpr } from '@/lib/noc/format';
import type { CellRow } from '@/lib/noc/snapshot';
import { cellTone, StatusDot, When } from './status';

/** Cells across cores (NOC design §9.4): one row each, linked to its detail. */
export function CellTable({ cells, now }: { cells: CellRow[]; now: number }) {
  if (cells.length === 0) return <p className="text-sm text-slate-500">No cells match.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="py-1 pr-4">Core</th>
            <th className="py-1 pr-4">Cell</th>
            <th className="py-1 pr-4">Name</th>
            <th className="py-1 pr-4">State</th>
            <th className="py-1 pr-4">Last HELLO</th>
            <th className="py-1 pr-4">Mode</th>
            <th className="py-1 pr-4 text-right">List</th>
            <th className="py-1 pr-4 text-right">Terminals</th>
            <th className="py-1 pr-4 text-right">Calls</th>
            <th className="py-1">Certificate</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {cells.map((c) => {
            const st = cellTone(c);
            return (
              <tr key={`${c.core}-${c.cellId}`} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-1 pr-4 font-mono">{c.core}</td>
                <td className="py-1 pr-4 font-mono">{c.cellId}</td>
                <td className="py-1 pr-4">
                  <Link href={`/noc/cells/${c.core}/${c.cellId}`} prefetch={false} className="text-brand underline">
                    {c.name}
                  </Link>
                </td>
                <td className="py-1 pr-4">
                  <StatusDot tone={st.tone} label={st.label} />
                </td>
                <td className="py-1 pr-4">
                  <When t={c.lastHeardAt} now={now} />
                </td>
                <td className="py-1 pr-4">{modeLabel(c.mode)}</td>
                <td className="py-1 pr-4 text-right font-mono">{c.group}</td>
                <td className="py-1 pr-4 text-right font-mono">{c.revoked ? '—' : c.terminals}</td>
                <td className="py-1 pr-4 text-right font-mono">{c.revoked ? '—' : c.calls}</td>
                <td className="py-1 font-mono text-xs">{c.certFpr ? shortFpr(c.certFpr) : <span className="text-slate-500">none pinned</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
