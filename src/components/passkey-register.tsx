'use client';

import { startRegistration } from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { passkeyRegisterFinish, passkeyRegisterStart } from '@/app/actions/auth';
import { reauthenticate } from '@/components/use-reauth';

export function PasskeyRegister({ then }: { then?: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setError('');
    try {
      // An admin first confirms with a passkey (the service answers `reauth`);
      // after that one confirmation, a second `reauth` answer is an error.
      let confirmed = false;
      for (;;) {
        const start = await passkeyRegisterStart();
        if (!start.ok) {
          if (!('reauth' in start) || confirmed) return setError(start.error);
          if (!(await reauthenticate())) return setError('The passkey confirmation did not work; nothing was changed.');
          confirmed = true;
          continue;
        }
        const response = await startRegistration({ optionsJSON: start.options });
        const r = await passkeyRegisterFinish(start.challengeId, response, name);
        if (!r.ok) {
          if (!('reauth' in r) || confirmed) return setError(r.error);
          if (!(await reauthenticate())) return setError('The passkey confirmation did not work; nothing was changed.');
          confirmed = true;
          continue;
        }
        break;
      }
      if (then) router.push(then);
      router.refresh();
    } catch {
      setError('The passkey was not created. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-sm font-medium">Name for this passkey (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="Phone, laptop, security key…" className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <button type="button" onClick={go} disabled={busy} className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark disabled:opacity-50">
        Add a passkey
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
