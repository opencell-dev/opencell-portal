'use client';

import { useActionState } from 'react';
import { changeEmailAction, deleteAccountAction, removePasskeyAction } from '@/app/actions/account';
import type { FormState } from '@/app/actions/auth';
import { reauthenticate } from '@/components/use-reauth';
import type { OwnedNumber } from '@/lib/owned-numbers';

const input = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900';

function Message({ state }: { state: FormState }) {
  if (!state) return null;
  return (
    <p role={state.ok ? 'status' : 'alert'} className={`text-sm ${state.ok ? '' : 'text-red-600'}`}>
      {state.message}
    </p>
  );
}

export function ChangeEmailForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(changeEmailAction, null);
  return (
    <form action={action} className="space-y-3">
      <label className="block">
        <span className="text-sm font-medium">New email</span>
        <input name="email" type="email" required maxLength={254} className={input} />
      </label>
      <Message state={state} />
      <button type="submit" disabled={pending} className="rounded border border-slate-300 px-4 py-2 dark:border-slate-700">
        Change email
      </button>
    </form>
  );
}

/**
 * Remove one passkey. An admin is asked to confirm with a passkey first (the
 * action answers `reauth`), then it is tried once more (as PromoteForm does).
 * Passkeys need JavaScript anyway, so this form does too.
 */
export function RemovePasskeyButton({ id, name }: { id: string; name: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(async () => {
    try {
      let r = await removePasskeyAction(id);
      if (!r.ok && 'reauth' in r) {
        if (!(await reauthenticate())) return { ok: false, message: 'The passkey confirmation did not work; nothing was changed.' };
        r = await removePasskeyAction(id);
        if (!r.ok && 'reauth' in r) return { ok: false, message: 'The passkey confirmation expired; try again.' };
      }
      return { ok: r.ok, message: r.message };
    } catch {
      return { ok: false, message: "Couldn't reach the portal. Please try again." };
    }
  }, null);
  return (
    <form action={action} className="inline">
      <button type="submit" disabled={pending} aria-label={`Remove ${name}`} className="text-sm text-red-600 underline">
        Remove
      </button>
      <Message state={state} />
    </form>
  );
}

export function DeleteAccountForm({ numbers }: { numbers: OwnedNumber[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(deleteAccountAction, null);
  const active = numbers.filter((n) => n.activated);
  return (
    <form action={action} className="space-y-3">
      {numbers.length === 0 ? (
        <p className="text-sm">You hold no numbers.</p>
      ) : (
        <p className="text-sm">Numbers never activated are released. For each activated number, choose:</p>
      )}
      {active.map((n) => (
        <fieldset key={n.number} className="rounded border border-slate-300 p-3 dark:border-slate-700">
          <legend className="px-1 font-mono text-sm">{n.number}</legend>
          <label className="mr-4 text-sm">
            <input type="radio" name={`choice:${n.number}`} value="keep" required /> keep it working, unmanaged
          </label>
          <label className="text-sm">
            <input type="radio" name={`choice:${n.number}`} value="disable" /> disable it
          </label>
        </fieldset>
      ))}
      <label className="block">
        <span className="text-sm font-medium">Type your email address to confirm</span>
        <input name="confirmEmail" type="email" required className={input} />
      </label>
      <Message state={state} />
      <button type="submit" disabled={pending} className="rounded bg-red-600 px-4 py-2 font-medium text-white">
        Delete my account
      </button>
    </form>
  );
}
