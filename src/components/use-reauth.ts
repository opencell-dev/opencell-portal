'use client';

import { startAuthentication } from '@simplewebauthn/browser';
import { reauthFinish, reauthStart } from '@/app/actions/auth';

/** Ask this account's passkey for a fresh assertion (admin re-auth); true when it worked. */
export async function reauthenticate(): Promise<boolean> {
  try {
    const { challengeId, options } = await reauthStart();
    const response = await startAuthentication({ optionsJSON: options });
    return (await reauthFinish(challengeId, response)).ok;
  } catch {
    return false;
  }
}

/**
 * Run an admin action that wants a fresh passkey: if it answers `reauth`, ask
 * for the passkey and run it once more. Returns its answer, or null when the
 * passkey did not confirm (nothing changed).
 */
export async function withFreshPasskey<T extends object>(call: () => Promise<T>, asking?: () => void): Promise<T | null> {
  const first = await call();
  if (!('reauth' in first)) return first;
  asking?.();
  if (!(await reauthenticate())) return null;
  return call();
}
