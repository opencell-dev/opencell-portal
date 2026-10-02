'use client';

import { useState } from 'react';
import { subscriberAction } from '@/app/actions/admin-noc';
import { reauthenticate } from '@/components/use-reauth';

/**
 * Disable or enable the looked-up number (plan N2a; decision 2026-10-01
 * #10): staff, a reason, and a fresh passkey. `done` re-reads the number.
 */
export function SubscriberControls({ number, disabled, done }: { number: string; disabled: boolean; done: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const enable = disabled;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const input = { number, enable, reason };
      let r = await subscriberAction(input);
      if (!r.ok && 'reauth' in r) {
        setMessage('Confirm with your passkey…');
        if (!(await reauthenticate())) {
          setMessage('The passkey confirmation did not work; nothing was changed.');
          return;
        }
        r = await subscriberAction(input);
      }
      setMessage('reauth' in r ? 'The passkey confirmation expired; try again.' : r.message);
      if (r.ok) {
        setReason('');
        await done();
      }
    } catch {
      setMessage("Couldn't reach the portal or your session has ended. Sign in again with your passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="max-w-2xl space-y-2 rounded border border-slate-300 p-3 dark:border-slate-700">
      <h2 className="font-semibold">{enable ? 'Enable this number' : 'Disable this number'}</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {enable
          ? 'It can register and call again.'
          : 'Its terminal is deregistered at once and can neither register nor call until the number is enabled. Calls in progress go on until they end.'}{' '}
        Needs your passkey; recorded with the reason in the portal&apos;s audit and the core&apos;s.
      </p>
      <label className="block text-sm">
        <span className="font-medium">Reason</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
          maxLength={200}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className={`rounded px-4 py-2 font-medium text-white disabled:opacity-50 ${enable ? 'bg-brand' : 'bg-red-700'}`}
      >
        {enable ? 'Enable' : 'Disable'}
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
