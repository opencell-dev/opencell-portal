import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SignUpForm } from '@/components/sign-up-form';
import { currentSession } from '@/server/request';

export const metadata: Metadata = { title: 'Sign up' };

export default async function SignUp() {
  if (await currentSession()) redirect('/numbers');
  return (
    <div className="max-w-md space-y-6">
      <h1 className="text-2xl font-semibold">Sign up</h1>
      <p className="text-slate-600 dark:text-slate-300">
        Tell us your name and email. We send a link to confirm the address; after that you add a passkey, and there is
        no password to remember.
      </p>
      <SignUpForm />
      <p className="text-sm">
        Already signed up?{' '}
        <Link href="/sign-in" className="text-brand underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
