'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { FormState } from '@/app/actions/auth';
import { requestMoreAction } from '@/app/actions/numbers';
import { FormMessage } from './form-message';

const input = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900';

/**
 * "＋ Get a number" (portal spec §5): how many are left; at the limit, a
 * short reason for an admin (§4.2); with 3 waiting, a nudge to activate.
 */
export function GetNumberCard({
  held,
  limit,
  why,
  pending,
}: {
  held: number;
  limit: number;
  why?: 'unactivated' | 'limit';
  pending: boolean;
}) {
  const [state, action, busy] = useActionState<FormState, FormData>(requestMoreAction, null);
  const left = Math.max(0, limit - held);
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-slate-300 p-4 dark:border-slate-700" data-testid="get-number-card">
      {why === undefined ? (
        <Link href="/numbers/new" className="text-lg font-medium text-brand underline">
          ＋ Get a number
        </Link>
      ) : (
        <p className="text-lg font-medium">＋ Get a number</p>
      )}
      <p className="text-sm text-slate-500">
        {left} of {limit} left
      </p>
      {why === 'unactivated' && <p className="text-sm">Activate or release a waiting number first.</p>}
      {why === 'limit' &&
        (pending || state?.ok ? (
          <p className="text-sm" role="status">
            Your request for more numbers is with an admin. You will hear back by email.
          </p>
        ) : (
          <form action={action} className="space-y-2">
            <p className="text-sm">You hold as many numbers as your account allows. To hold more, tell us why:</p>
            <label className="block text-sm">
              <span className="font-medium">Why do you need more?</span>
              <textarea name="reason" required minLength={10} maxLength={500} rows={3} className={input} />
            </label>
            <label className="block text-sm">
              <span className="font-medium">How many in all</span>
              <input name="wanted" type="number" min={limit + 1} max={20} defaultValue={limit + 1} required className={input} />
            </label>
            <FormMessage state={state} />
            <button type="submit" disabled={busy} className="rounded border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
              Ask for more numbers
            </button>
          </form>
        ))}
    </div>
  );
}
