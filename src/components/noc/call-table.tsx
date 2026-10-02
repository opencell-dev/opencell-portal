import Link from 'next/link';
import type { LegKind } from '@/core/types';
import { CAUSES } from '@/core/wire-noc';
import { callResult } from '@/lib/noc/activity';
import type { CallRecord } from '@/lib/noc/calls';
import { exact, groupNumber } from '@/lib/noc/format';
import { RESULT_LABEL } from './activity';

const LEG: Record<LegKind, string> = { cell: 'cell', echo: 'echo service', playback: 'playback service', peer: 'another core' };

/** A leg: its cell (a link to the cell's page), or what it was. */
export function Leg({ core, cell, kind }: { core: string; cell: number | null; kind: LegKind }) {
  if (cell !== null) {
    return (
      <Link href={`/noc/cells/${core}/${cell}`} prefetch={false} className="underline">
        cell {cell}
      </Link>
    );
  }
  return <span className="text-slate-500">{LEG[kind]}</span>;
}

export function ringS(c: Pick<CallRecord, 'setupAt' | 'answerAt' | 'endAt'>): number {
  return Math.max(0, Math.round(((c.answerAt ?? c.endAt) - c.setupAt) / 1000));
}

export function talkS(c: Pick<CallRecord, 'answerAt' | 'endAt'>): number {
  return c.answerAt === null ? 0 : Math.max(0, Math.round((c.endAt - c.answerAt) / 1000));
}

/** The Calls page's list (plan N2a): newest first, each row linking to the call. */
export function CallTable({ rows }: { rows: CallRecord[] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">No calls match.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="py-1 pr-4">Ended (UTC)</th>
            <th className="py-1 pr-4">Core</th>
            <th className="py-1 pr-4">Caller</th>
            <th className="py-1 pr-4">Called</th>
            <th className="py-1 pr-4">From</th>
            <th className="py-1 pr-4">To</th>
            <th className="py-1 pr-4 text-right">Ring</th>
            <th className="py-1 pr-4 text-right">Talk</th>
            <th className="py-1 pr-4">Result</th>
            <th className="py-1">Cause</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((c) => (
            <tr key={`${c.core}-${c.id}`} className="border-b border-slate-100 dark:border-slate-900">
              <td className="py-1 pr-4 font-mono">
                <Link href={`/noc/calls/${c.core}/${c.id}`} prefetch={false} className="underline">
                  {exact(c.endAt).replace(' UTC', '')}
                </Link>
              </td>
              <td className="py-1 pr-4 font-mono">{c.core}</td>
              <td className="py-1 pr-4 font-mono">{groupNumber(c.caller)}</td>
              <td className="py-1 pr-4 font-mono">{groupNumber(c.called)}</td>
              <td className="py-1 pr-4">
                <Leg core={c.core} cell={c.cellA} kind={c.legA} />
              </td>
              <td className="py-1 pr-4">
                <Leg core={c.core} cell={c.cellB} kind={c.legB} />
              </td>
              <td className="py-1 pr-4 text-right font-mono">{ringS(c)} s</td>
              <td className="py-1 pr-4 text-right font-mono">{talkS(c)} s</td>
              <td className="py-1 pr-4">{RESULT_LABEL[callResult(c)]}</td>
              <td className="py-1">{CAUSES[c.cause] ?? c.cause}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
