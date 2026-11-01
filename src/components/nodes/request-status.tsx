'use client';

import { useActionState } from 'react';
import type { FormState } from '@/app/actions/auth';
import { FormMessage } from '@/components/numbers/form-message';

/** Withdraw an open request. */
export function WithdrawForm({ id, action }: { id: number; action: (prev: FormState, form: FormData) => Promise<FormState> }) {
  const [state, run, pending] = useActionState<FormState, FormData>(action, null);
  return (
    <form action={run} className="space-y-1">
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending} className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700">
        Withdraw this request
      </button>
      <FormMessage state={state} />
    </form>
  );
}
