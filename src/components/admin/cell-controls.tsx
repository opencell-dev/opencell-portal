'use client';

import { useState } from 'react';
import { revokeCellAction } from '@/app/actions/admin-cells';
import { npaOverrideAction } from '@/app/actions/admin-blocks';
import { withFreshPasskey } from '@/components/use-reauth';

const button = 'rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700';
const input = 'rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900';
const SESSION_GONE = "Couldn't reach the portal or your admin session has ended. Sign in again with your passkey.";
const NOT_CONFIRMED = 'The passkey confirmation did not work; nothing was changed.';

/** Revoke a cell (spec §3): the admin types its name, and a fresh passkey. */
export function RevokeCell({ coreId, cellId, name }: { coreId: string; cellId: number; name: string }) {
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await withFreshPasskey(() => revokeCellAction(coreId, cellId, typed), () => setMessage('Confirm with your passkey…'));
      setMessage(r === null ? NOT_CONFIRMED : 'reauth' in r ? 'The passkey confirmation expired; try again.' : r.message);
    } catch {
      setMessage(SESSION_GONE);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <label className="text-sm">
        <span className="sr-only">Type {name} to revoke cell {cellId}</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} required placeholder={`Type ${name}`} aria-label={`Type ${name} to revoke cell ${cellId}`} className={input} />
      </label>
      <button type="submit" disabled={busy} className={button}>
        Revoke
      </button>
      {message && <span role="status">{message}</span>}
    </form>
  );
}

/** Note the home an admin wants for an NPA. It changes no routing: the command below does, on the laptop. */
export function NpaOverrideForm({ cores }: { cores: number[] }) {
  const [npa, setNpa] = useState('');
  const [core, setCore] = useState(String(cores[0] ?? ''));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function send(home: number | null) {
    setBusy(true);
    try {
      const r = await withFreshPasskey(() => npaOverrideAction(npa, home), () => setMessage('Confirm with your passkey…'));
      setMessage(r === null ? NOT_CONFIRMED : 'reauth' in r ? 'The passkey confirmation expired; try again.' : r.message);
    } catch {
      setMessage(SESSION_GONE);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send(Number(core));
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <label className="flex flex-col text-sm">
        <span className="font-medium">Area code</span>
        <input value={npa} onChange={(e) => setNpa(e.target.value)} required pattern="[2-9][0-9][0-9]" maxLength={3} className={input} />
      </label>
      <label className="flex flex-col text-sm">
        <span className="font-medium">Home core</span>
        <select value={core} onChange={(e) => setCore(e.target.value)} className={input}>
          {cores.map((c) => (
            <option key={c} value={c}>
              Core {c}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={busy} className={button}>
        Note this home
      </button>
      <button type="button" disabled={busy || npa === ''} onClick={() => void send(null)} className={button}>
        Clear it
      </button>
      {message && (
        <p role="status" className="w-full text-sm">
          {message}
        </p>
      )}
    </form>
  );
}
