'use client';

import { useState } from 'react';
import { promoteAction } from '@/app/actions/admin';
import { reauthenticate } from '@/components/use-reauth';

export function PromoteForm() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      let r = await promoteAction(email);
      if (!r.ok && 'reauth' in r) {
        setMessage('Confirm with your passkey…');
        if (!(await reauthenticate())) {
          setMessage('The passkey confirmation did not work; nothing was changed.');
          return;
        }
        r = await promoteAction(email);
      }
      setMessage('reauth' in r ? 'The passkey confirmation expired; try again.' : r.message);
    } catch {
      // A network failure lands here, and so does an admin session that has ended
      // (requireAdmin's redirect or 404 reaches the client as a thrown action).
      setMessage("Couldn't reach the portal or your admin session has ended. Sign in again with your passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-sm font-medium">Email of the account to make an admin</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <button type="submit" disabled={busy} className="rounded bg-brand px-4 py-2 font-medium text-white disabled:opacity-50">
        Make admin
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
