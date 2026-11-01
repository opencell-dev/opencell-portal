'use client';

import { useActionState } from 'react';
import type { FormState } from '@/app/actions/auth';
import { FormMessage } from '@/components/numbers/form-message';
import { LocalTime } from '@/components/numbers/local-time';

export interface ThreadRow {
  id: number;
  fromAdmin: boolean;
  body: string;
  at: number;
}

/** The request's thread (portal spec §6.2), as the requester or an admin reads it. */
export function Thread({ rows, viewer }: { rows: ThreadRow[]; viewer: 'requester' | 'admin' }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">No messages yet.</p>;
  return (
    <ul className="space-y-3">
      {rows.map((m) => (
        <li key={m.id} className="rounded border border-slate-200 p-3 dark:border-slate-800" data-from={m.fromAdmin ? 'admin' : 'requester'}>
          <p className="text-xs text-slate-500">
            {m.fromAdmin ? (viewer === 'admin' ? 'An admin' : 'OpenCell admin') : viewer === 'admin' ? 'The requester' : 'You'} · <LocalTime t={m.at} />
          </p>
          <p className="whitespace-pre-wrap">{m.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** One text box and a button, for a thread message or a note. */
export function MessageForm({
  action,
  id,
  label,
  button,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  id: number;
  label: string;
  button: string;
}) {
  const [state, run, pending] = useActionState<FormState, FormData>(action, null);
  return (
    <form action={run} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label className="block text-sm">
        <span className="font-medium">{label}</span>
        <textarea name="body" required maxLength={2000} rows={3} className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <button type="submit" disabled={pending} className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700">
        {button}
      </button>
      <FormMessage state={state} />
    </form>
  );
}
