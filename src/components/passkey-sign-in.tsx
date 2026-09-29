'use client';

import { startAuthentication } from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { passkeySignInFinish, passkeySignInStart } from '@/app/actions/auth';

export function PasskeySignIn({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setError('');
    try {
      const start = await passkeySignInStart();
      if (!start.ok) return setError(start.error);
      const response = await startAuthentication({ optionsJSON: start.options });
      const r = await passkeySignInFinish(start.challengeId, response);
      if (!r.ok) return setError(r.error);
      router.push(next);
      router.refresh();
    } catch {
      setError('Signing in with a passkey did not work. Try again, or use an email link.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={go} disabled={busy} className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark disabled:opacity-50">
        Sign in with a passkey
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
