'use client';

import { useState } from 'react';
import type { AdminResult } from '@/app/actions/admin';
import { disableAccountAction, enableAccountAction, numberDisabledAction } from '@/app/actions/admin-subscribers';
import { withFreshPasskey } from '@/components/use-reauth';

const SESSION_GONE = "Couldn't reach the portal or your admin session has ended. Sign in again with your passkey.";
const button = 'rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700';

/** What a fresh-passkey action said, in one line. */
function say(r: AdminResult | null): string {
  if (r === null) return 'The passkey confirmation did not work; nothing was changed.';
  return 'reauth' in r ? 'The passkey confirmation expired; try again.' : r.message;
}

/** Disable an account (portal spec §10: "after confirmation"): the admin types its email. */
export function DisableAccountForm({ id }: { id: number }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      setMessage(say(await withFreshPasskey(() => disableAccountAction(id, email), () => setMessage('Confirm with your passkey…'))));
    } catch {
      setMessage(SESSION_GONE);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="max-w-md space-y-2">
      <label className="block text-sm">
        <span className="font-medium">Type the account&apos;s email to disable it and its numbers</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <button type="submit" disabled={busy} className={button}>
        Disable this account
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

/** The same action again, for the numbers a core didn't answer for the first time. */
export function FinishDisablingButton({ id, email }: { id: number; email: string }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      setMessage(say(await withFreshPasskey(() => disableAccountAction(id, email), () => setMessage('Confirm with your passkey…'))));
    } catch {
      setMessage(SESSION_GONE);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1">
      <button type="button" onClick={go} disabled={busy} className={button}>
        Finish disabling: some numbers are still on
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export function EnableAccountButton({ id, label }: { id: number; label: string }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      setMessage(say(await withFreshPasskey(() => enableAccountAction(id), () => setMessage('Confirm with your passkey…'))));
    } catch {
      setMessage(SESSION_GONE);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1">
      <button type="button" onClick={go} disabled={busy} className={button}>
        {label}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export function NumberDisabledButton({ number, disabled }: { number: string; disabled: boolean }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      setMessage(say(await withFreshPasskey(() => numberDisabledAction(number, !disabled), () => setMessage('Confirm with your passkey…'))));
    } catch {
      setMessage(SESSION_GONE);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={go} disabled={busy} className={button}>
        {disabled ? 'Enable' : 'Disable'}
      </button>
      {message && <span role="status">{message}</span>}
    </span>
  );
}
