import type { Metadata } from 'next';
import Link from 'next/link';
import { MagicLinkForm } from '@/components/magic-link-form';
import { PasskeySignIn } from '@/components/passkey-sign-in';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignIn({ searchParams }: { searchParams: Promise<{ admin?: string }> }) {
  const { admin } = await searchParams;
  return (
    <div className="max-w-md space-y-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {admin && (
        <p role="status" className="rounded border border-amber-500 p-3 text-sm">
          Admin pages need a sign-in with a passkey. An email link is not enough.
        </p>
      )}
      <section className="space-y-2">
        <PasskeySignIn next={admin ? '/admin' : '/numbers'} />
      </section>
      <section className="space-y-2">
        <h2 className="font-medium">No passkey on this device?</h2>
        <MagicLinkForm />
      </section>
      <p className="text-sm">
        New here?{' '}
        <Link href="/sign-up" className="text-brand underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
