import type { Metadata } from 'next';
import Link from 'next/link';
import { PasskeyRegister } from '@/components/passkey-register';
import { appCtx } from '@/lib/ctx';
import { listPasskeys } from '@/lib/passkeys';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Welcome' };

export default async function Welcome() {
  const { user } = await requireUser();
  const has = listPasskeys(appCtx(), user.id).length > 0;
  return (
    <div className="max-w-md space-y-6">
      <h1 className="text-2xl font-semibold">Welcome, {user.name}</h1>
      <p>Your email is confirmed.</p>
      {has ? (
        <p role="status">Your passkey is ready. Next time, sign in with it.</p>
      ) : (
        <>
          <p>
            Add a passkey so you can sign in with your phone’s or computer’s screen lock, or a security key. There is no
            password.
          </p>
          <PasskeyRegister />
        </>
      )}
      <Link href="/numbers" className="inline-block text-brand underline">
        {has ? 'Continue to my numbers' : 'Skip for now'}
      </Link>
    </div>
  );
}
