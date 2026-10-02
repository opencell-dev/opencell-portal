import Link from 'next/link';
import type { Registration } from '@/core/types';
import { groupNumber } from '@/lib/noc/format';
import { db, dbm, tierFor } from '@/lib/noc/signal';
import { When } from './status';

/**
 * Registered terminals with their signal (reg.list, plan N2a): number, TMID
 * prefix, cell, when it registered and expires, RSSI, SNR, the tier the SNR
 * would carry (an estimate, signal.ts) and when the cell last heard it.
 */
export function TerminalTable({ rows, now, core, showCell = true }: { rows: Registration[]; now: number; core: string; showCell?: boolean }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">No terminals registered.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="py-1 pr-4">Number</th>
            <th className="py-1 pr-4">TMID</th>
            {showCell && <th className="py-1 pr-4">Cell</th>}
            <th className="py-1 pr-4">Registered</th>
            <th className="py-1 pr-4">Expires</th>
            <th className="py-1 pr-4 text-right">RSSI</th>
            <th className="py-1 pr-4 text-right">SNR</th>
            <th className="py-1 pr-4">Tier (est.)</th>
            <th className="py-1">Heard</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r) => (
            <tr key={r.number} className="border-b border-slate-100 dark:border-slate-900">
              <td className="py-1 pr-4 font-mono">{groupNumber(r.number)}</td>
              <td className="py-1 pr-4 font-mono">{r.tmidPrefix}</td>
              {showCell && (
                <td className="py-1 pr-4 font-mono">
                  <Link href={`/noc/cells/${core}/${r.cellId}`} prefetch={false} className="underline">
                    {r.cellId}
                  </Link>
                </td>
              )}
              <td className="py-1 pr-4">
                <When t={r.registeredAt} now={now} />
              </td>
              <td className="py-1 pr-4">
                <When t={r.expiresAt} now={now} future />
              </td>
              <td className="py-1 pr-4 text-right font-mono">{dbm(r.rssiDbm)}</td>
              <td className="py-1 pr-4 text-right font-mono">{db(r.snrDb)}</td>
              <td className="py-1 pr-4">{tierFor(r.snrDb) ?? 'not heard'}</td>
              <td className="py-1">
                <When t={r.heardAt} now={now} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
