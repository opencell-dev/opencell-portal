'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cellModeAction } from '@/app/actions/admin-noc';
import { reauthenticate } from '@/components/use-reauth';
import type { CellMode } from '@/core/types';

const LABEL: Record<CellMode, string> = { part15: 'Part 15', part97: 'Part 97' };

/**
 * Switch a cell between Part 15 and Part 97 (plan N2a), admins only: the
 * impact is said first, the cell's name is typed to confirm, a reason is
 * given, and the passkey confirms it.
 */
export function ModeSwitch({ core, cellId, name, mode, calls }: { core: string; cellId: number; name: string; mode: CellMode; calls: number }) {
  const router = useRouter();
  const to: CellMode = mode === 'part15' ? 'part97' : 'part15';
  const [confirmName, setConfirmName] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const input = { core, cellId, mode: to, confirmName, reason };
      let r = await cellModeAction(input);
      if (!r.ok && 'reauth' in r) {
        setMessage('Confirm with your passkey…');
        if (!(await reauthenticate())) {
          setMessage('The passkey confirmation did not work; nothing was changed.');
          return;
        }
        r = await cellModeAction(input);
      }
      setMessage('reauth' in r ? 'The passkey confirmation expired; try again.' : r.message);
      if (r.ok) {
        setConfirmName('');
        setReason('');
        router.refresh();
      }
    } catch {
      setMessage("Couldn't reach the portal or your session has ended. Sign in again with your passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="max-w-2xl space-y-2 rounded border border-amber-500 p-3">
      <h2 className="font-semibold">
        Switch to {LABEL[to]} (now {LABEL[mode]})
      </h2>
      <p className="text-sm">
        Every call on this cell ends at once ({calls === 0 ? 'none is up' : `${calls} up`} as of the last look), and the cell reconnects in{' '}
        {LABEL[to]} within seconds; its terminals carry on in the new mode. Admins only; needs your passkey; recorded with the reason.
      </p>
      <label className="block text-sm">
        <span className="font-medium">Type the cell&apos;s name to confirm: {name}</span>
        <input
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
          required
          maxLength={64}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
        />
      </label>
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
      <button type="submit" disabled={busy || confirmName !== name} className="rounded bg-red-700 px-4 py-2 font-medium text-white disabled:opacity-50">
        Switch to {LABEL[to]}
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
