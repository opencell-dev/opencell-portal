'use client';

import { useActionState } from 'react';
import { decideLimitAction } from '@/app/actions/admin-limits';
import type { FormState } from '@/app/actions/auth';
import { FormMessage } from '@/components/numbers/form-message';

const input = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900';
const button = 'rounded border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 disabled:opacity-50';

/** The two decisions on a request for more numbers (/admin/limits). */
export function LimitDecision({ id, limit, wanted, max }: { id: number; limit: number; wanted: number; max: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(decideLimitAction, null);
  const options = Array.from({ length: max - limit }, (_, i) => limit + 1 + i);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-6">
        <form action={action} className="flex items-end gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="outcome" value="raised" />
          <label className="text-sm">
            <span className="font-medium">Raise to</span>
            <select name="limit" defaultValue={Math.min(Math.max(wanted, limit + 1), max)} className={input}>
              {options.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={pending} className={button}>
            Raise
          </button>
        </form>
        <form action={action} className="flex flex-1 items-end gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="outcome" value="declined" />
          <label className="flex-1 text-sm">
            <span className="font-medium">Or decline, saying why</span>
            <input name="note" required maxLength={500} className={input} />
          </label>
          <button type="submit" disabled={pending} className={button}>
            Decline
          </button>
        </form>
      </div>
      <FormMessage state={state} />
    </div>
  );
}
