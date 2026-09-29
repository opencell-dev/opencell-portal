'use client';

import { useActionState } from 'react';
import { type FormState, signUpAction } from '@/app/actions/auth';
import { AltchaWidget } from '@/components/altcha-widget';

export function SignUpForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(signUpAction, null);
  if (state?.ok) {
    return (
      <p role="status" className="rounded border border-brand p-4">
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Name</span>
        <input name="name" required maxLength={80} autoComplete="name" className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Email</span>
        <input name="email" type="email" required maxLength={254} autoComplete="email" className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <AltchaWidget />
      {state && !state.ok && (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark disabled:opacity-50">
        {pending ? 'Sending…' : 'Sign up'}
      </button>
    </form>
  );
}
