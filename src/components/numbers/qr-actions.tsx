'use client';

import { useActionState, useState } from 'react';
import type { FormState } from '@/app/actions/auth';
import { emailQrAction, getNumberAction, releaseAction, reissueAction, simulateAction } from '@/app/actions/numbers';
import { FormMessage } from './form-message';

// The number forms. Each posts to its server action, so it works without
// JavaScript as well; the ones that break something (re-issue, release) ask
// first, in a <details>, which needs no script either.

const button = 'rounded border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 disabled:opacity-50';
const primary = 'rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark disabled:opacity-50';

/** The confirm step's form (spec §4.1 step 3): the directory box ticked by default (opt-out, §5). */
export function GetNumberForm({ number }: { number: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(getNumberAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="number" value={number} />
      <label className="flex items-start gap-2">
        <input type="checkbox" name="listed" defaultChecked className="mt-1" />
        <span>List this number in the directory (signed-in subscribers can find your name and this number)</span>
      </label>
      <FormMessage state={state} />
      <button type="submit" disabled={pending} aria-busy={pending} className={primary}>
        Get this number
      </button>
    </form>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={button}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function EmailQrForm({ number }: { number: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(emailQrAction, null);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="number" value={number} />
      <button type="submit" disabled={pending} className={button}>
        Email it to me
      </button>
      <FormMessage state={state} />
    </form>
  );
}

/** Re-issue (unactivated) or move to a new terminal (activated): a new token; the old one stops working. */
export function ReissueForm({ number, label, warning }: { number: string; label: string; warning: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(reissueAction, null);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer underline">{label}</summary>
      <form action={action} className="mt-2 space-y-2">
        <input type="hidden" name="number" value={number} />
        <p>{warning}</p>
        <button type="submit" disabled={pending} className={button}>
          Make a new QR code
        </button>
        <FormMessage state={state} />
      </form>
    </details>
  );
}

export function ReleaseForm({ number }: { number: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(releaseAction, null);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-red-600 underline">Release</summary>
      <form action={action} className="mt-2 space-y-2">
        <input type="hidden" name="number" value={number} />
        <p>The number goes back to the pool, and its QR code stops working.</p>
        <button type="submit" disabled={pending} className={`${button} text-red-600`}>
          Release this number
        </button>
        <FormMessage state={state} />
      </form>
    </details>
  );
}

/** OC_CORE=fake only: play a terminal or a cell for this number. */
export function SimulateForm({ number, op, label }: { number: string; op: 'activate' | 'register'; label: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(simulateAction, null);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="number" value={number} />
      <input type="hidden" name="op" value={op} />
      <button type="submit" disabled={pending} className={`${button} border-dashed`}>
        {label}
      </button>
      <FormMessage state={state} />
    </form>
  );
}
