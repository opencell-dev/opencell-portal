'use client';

import { useState } from 'react';
import { lookupNumberAction } from '@/app/actions/admin-noc';
import type { LookupResult } from '@/lib/noc/lookup';
import { exact, groupNumber } from '@/lib/noc/format';

const RESULT: Record<string, string> = {
  answered: 'answered',
  busy: 'busy',
  unreachable: 'unreachable',
  no_answer: 'no answer',
  failed: 'failed',
};

/**
 * One number's status and recent calls (NOC design §9.5), open to admins and
 * NOC operators (ruling 2026-10-01 #8/#9). A POST (server action), not a
 * URL: the number stays out of the address bar, the proxies' logs and the
 * browser's history.
 */
export function NumberLookup({ serviceNumbers }: { serviceNumbers: string[] }) {
  const [number, setNumber] = useState('');
  const [r, setR] = useState<LookupResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      setR(await lookupNumberAction(number));
    } catch {
      setR({ ok: false, message: "Couldn't reach the portal or your session has ended. Sign in again with your passkey." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-sm">
          <span className="font-medium">Number</span>
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            required
            maxLength={40}
            placeholder="+883-1-717-464-12345"
            className="mt-1 w-72 rounded border border-slate-300 px-3 py-2 font-mono dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <button type="submit" disabled={busy} className="rounded bg-brand px-4 py-2 font-medium text-white disabled:opacity-50">
          Look up
        </button>
      </form>
      {r && !r.ok && <p role="alert">{r.message}</p>}
      {r?.ok && (
        <div className="space-y-4">
          <dl role="status" className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-slate-500">Number</dt>
            <dd className="font-mono">{groupNumber(r.number)}</dd>
            <dt className="text-slate-500">Core</dt>
            <dd className="font-mono">{r.core}</dd>
            <dt className="text-slate-500">State</dt>
            <dd>
              {r.status.state}
              {r.status.disabled ? ', disabled' : ''}
            </dd>
            <dt className="text-slate-500">Registered</dt>
            <dd>{r.status.registered ? `yes, on cell ${r.status.cellId}` : 'no'}</dd>
            <dt className="text-slate-500">Terminal (TMID prefix)</dt>
            <dd className="font-mono">{r.status.tmidPrefix ?? '—'}</dd>
            <dt className="text-slate-500">Last seen</dt>
            <dd>{r.status.lastSeenAt ? exact(r.status.lastSeenAt) : 'never'}</dd>
            {r.status.tokenExpiresAt && (
              <>
                <dt className="text-slate-500">Activation code expires</dt>
                <dd>{exact(r.status.tokenExpiresAt)}</dd>
              </>
            )}
          </dl>
          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Calls, last 30 days</h2>
            {r.cdrs.length === 0 ? (
              <p className="text-sm text-slate-500">No calls.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-slate-500">
                    <tr className="border-b border-slate-200 dark:border-slate-800">
                      <th className="py-1 pr-4">Time (UTC)</th>
                      <th className="py-1 pr-4">Direction</th>
                      <th className="py-1 pr-4">Other party</th>
                      <th className="py-1 pr-4 text-right">Duration</th>
                      <th className="py-1">Result</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {r.cdrs.map((c, i) => (
                      <tr key={`${c.at}-${i}`} className="border-b border-slate-100 dark:border-slate-900">
                        <td className="py-1 pr-4 font-mono">{exact(c.at).replace(' UTC', '')}</td>
                        <td className="py-1 pr-4">{c.direction === 'out' ? 'outgoing' : 'incoming'}</td>
                        <td className="py-1 pr-4 font-mono">
                          {groupNumber(c.peer)}
                          {serviceNumbers.includes(c.peer) && <span className="ml-2 rounded bg-sky-100 px-1 font-sans text-xs text-sky-800 dark:bg-sky-900 dark:text-sky-200">service</span>}
                        </td>
                        <td className="py-1 pr-4 text-right font-mono">{c.durationS} s</td>
                        <td className="py-1">{RESULT[c.result] ?? c.result}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {r.more && <p className="text-xs text-slate-500">Only the newest 100 are shown.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
