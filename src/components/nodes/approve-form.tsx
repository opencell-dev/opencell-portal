'use client';

import { useState } from 'react';
import { approveAction } from '@/app/actions/admin-nodes';
import { reauthenticate } from '@/components/use-reauth';

const input = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900';

/** Approve (portal spec §6.2): core, anchor and board role prefilled; a fresh passkey when the session's is stale. */
export function ApproveForm({ id, cores, coreId, anchor, boardRole }: { id: number; cores: { id: string; cellAddr: string }[]; coreId: string | null; anchor: number; boardRole: 'bs' | 'bench' }) {
  const [core, setCore] = useState(coreId ?? cores[0]?.id ?? '');
  const [a, setA] = useState(String(anchor));
  const [role, setRole] = useState(boardRole);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const opts = { coreId: core, anchor: Number(a), boardRole: role };
    try {
      let r = await approveAction(id, opts);
      if (!r.ok && 'reauth' in r) {
        setMessage('Confirm with your passkey…');
        if (!(await reauthenticate())) {
          setMessage('The passkey confirmation did not work; nothing was changed.');
          return;
        }
        r = await approveAction(id, opts);
      }
      setMessage('reauth' in r ? 'The passkey confirmation expired; try again.' : r.message);
      setDone(r.ok);
    } catch {
      setMessage("Couldn't reach the portal or your admin session has ended. Sign in again with your passkey.");
    } finally {
      setBusy(false);
    }
  }

  if (cores.length === 0) return <p role="status">No core takes cells: set OC_CORE_&lt;ID&gt;_CELLS in portal.env.</p>;
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="font-medium">Core</span>
          <select value={core} onChange={(e) => setCore(e.target.value)} className={input}>
            {cores.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} ({c.cellAddr})
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Anchor (0 to 51)</span>
          <input type="number" min={0} max={51} required value={a} onChange={(e) => setA(e.target.value)} className={input} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Board role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as 'bs' | 'bench')} className={input}>
            <option value="bs">Base station (GPS fitted)</option>
            <option value="bench">Bench (no GPS)</option>
          </select>
        </label>
      </div>
      <button type="submit" disabled={busy || done} className="rounded bg-brand px-4 py-2 font-medium text-white disabled:opacity-50">
        Approve
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
