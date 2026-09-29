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
