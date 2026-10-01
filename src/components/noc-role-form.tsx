'use client';

import { useState } from 'react';
import { nocRoleAction } from '@/app/actions/admin';
import { reauthenticate } from '@/components/use-reauth';

/** Grant or take away the NOC operator role (NOC design §4), with a fresh passkey. */
export function NocRoleForm() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(grant: boolean) {
    setBusy(true);
    try {
      let r = await nocRoleAction(email, grant);
      if (!r.ok && 'reauth' in r) {
        setMessage('Confirm with your passkey…');
        if (!(await reauthenticate())) {
          setMessage('The passkey confirmation did not work; nothing was changed.');
          return;
        }
        r = await nocRoleAction(email, grant);
      }
      setMessage('reauth' in r ? 'The passkey confirmation expired; try again.' : r.message);
    } catch {
      setMessage("Couldn't reach the portal or your session has ended. Sign in again with your passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send(true);
      }}
      className="space-y-3"
    >
      <label className="block">
        <span className="text-sm font-medium">Email of the account (NOC operator)</span>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          required
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
        />
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded bg-brand px-4 py-2 font-medium text-white disabled:opacity-50">
          Make NOC operator
        </button>
        <button
          type="button"
          disabled={busy || email === ''}
          onClick={() => void send(false)}
          className="rounded border border-slate-300 px-4 py-2 font-medium disabled:opacity-50 dark:border-slate-700"
        >
          Remove NOC operator
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
