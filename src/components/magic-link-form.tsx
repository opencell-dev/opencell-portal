'use client';

import { useActionState } from 'react';
import { type FormState, magicLinkAction } from '@/app/actions/auth';

export function MagicLinkForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(magicLinkAction, null);
  return (
    <form action={action} className="space-y-3">
      <label className="block">
        <span className="text-sm font-medium">Email</span>
        <input name="email" type="email" required maxLength={254} autoComplete="email" className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      {state && (
        <p role={state.ok ? 'status' : 'alert'} className={`text-sm ${state.ok ? '' : 'text-red-600'}`}>
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className="rounded border border-slate-300 px-4 py-2 dark:border-slate-700 disabled:opacity-50">
        Email me a sign-in link
      </button>
    </form>
  );
}
