import type { Metadata } from 'next';
import type { Cdr } from '@/core/types';
import { LocalTime } from '@/components/numbers/local-time';
import { appCtx } from '@/lib/ctx';
import { accountCalls, CALLS_DAYS, CALLS_MAX } from '@/lib/numbers/calls';
import { spacedNumber } from '@/lib/numbers/format';
import { listNumbers } from '@/lib/numbers/ownership';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Calls' };

const RESULT: Record<Cdr['result'], string> = {
  answered: 'Answered',
  busy: 'Busy',
  unreachable: 'Unreachable',
  no_answer: 'No answer',
  failed: 'Failed',
};

const mss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Calls (portal spec §5): the CDRs of your numbers for 90 days, from each number's home core. */
export default async function Calls({ searchParams }: { searchParams: Promise<{ number?: string | string[] }> }) {
  const { user } = await requireUser();
  const ctx = appCtx();
  const raw = (await searchParams).number;
  const filter = typeof raw === 'string' && raw !== '' ? raw : undefined;
  const mine = listNumbers(ctx, user.id).map((r) => r.number);
  const { calls, unavailable, limited } = await accountCalls(ctx, user.id, filter);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Calls</h1>
      <p className="text-slate-600 dark:text-slate-300">Calls to and from your numbers, for the last {CALLS_DAYS} days.</p>
      {mine.length > 1 && (
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="font-medium">Number</span>
            <select name="number" defaultValue={filter ?? ''} className="mt-1 block rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
              <option value="">All my numbers</option>
              {mine.map((n) => (
                <option key={n} value={n}>
                  {spacedNumber(n)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
            Show
          </button>
        </form>
      )}
      {unavailable.length > 0 && (
        <p role="note" className="rounded border border-amber-500 p-3 text-sm">
          The network didn&apos;t answer for {unavailable.map(spacedNumber).join(', ')}: those calls are missing. Try again in a minute.
        </p>
      )}
      {limited && (
        <p role="note" className="rounded border border-amber-500 p-3 text-sm">
          {limited}
        </p>
      )}
      {limited ? null : calls.length === 0 ? (
        <p>{mine.length === 0 ? 'You have no numbers yet.' : 'No calls in this time.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="py-2 pr-4">Time</th>
                <th className="py-2 pr-4">My number</th>
                <th className="py-2 pr-4">Other party</th>
                <th className="py-2 pr-4">Direction</th>
                <th className="py-2 pr-4">Duration</th>
                <th className="py-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c, i) => (
                <tr key={`${c.mine}-${c.at}-${i}`} className="border-b border-slate-100 dark:border-slate-900">
                  <td className="py-1 pr-4 whitespace-nowrap">
                    <LocalTime t={c.at} />
                  </td>
                  <td className="py-1 pr-4 font-mono whitespace-nowrap">{spacedNumber(c.mine)}</td>
                  <td className="py-1 pr-4 font-mono whitespace-nowrap">{spacedNumber(c.peer)}</td>
                  <td className="py-1 pr-4">{c.direction === 'in' ? 'In' : 'Out'}</td>
                  <td className="py-1 pr-4">{mss(c.durationS)}</td>
                  <td className="py-1">{RESULT[c.result] ?? c.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {calls.length >= CALLS_MAX && <p className="mt-2 text-sm text-slate-500">The newest {CALLS_MAX} calls are shown.</p>}
        </div>
      )}
    </div>
  );
}
