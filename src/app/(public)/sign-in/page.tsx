import type { Metadata } from 'next';
import Link from 'next/link';
import { MagicLinkForm } from '@/components/magic-link-form';
import { PasskeySignIn } from '@/components/passkey-sign-in';
import { appCtx } from '@/lib/ctx';
import { siteHome } from '@/lib/site';
import { STAFF_ONLY } from '@/lib/users';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignIn({ searchParams }: { searchParams: Promise<{ admin?: string; noc?: string; staff?: string }> }) {
  const { admin, noc, staff } = await searchParams;
  // NOC design §N1.5: the NOC's own site signs in staff only, and has no sign-up.
  const site = appCtx().config.site;
  const nocSite = site === 'noc';
  return (
    <div className="max-w-md space-y-8">
      <h1 className="text-2xl font-semibold">{nocSite ? 'Sign in to the OpenCell NOC' : 'Sign in'}</h1>
      {nocSite && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          For OpenCell staff. An administrator makes your account. Subscribers sign in on the OpenCell portal.
        </p>
      )}
      {nocSite && staff && (
        <p role="status" className="rounded border border-amber-500 p-3 text-sm">
          {STAFF_ONLY}
        </p>
      )}
      {admin && (
        <p role="status" className="rounded border border-amber-500 p-3 text-sm">
          Admin pages need a sign-in with a passkey. An email link is not enough.
        </p>
      )}
      {!admin && noc && (
        <p role="status" className="rounded border border-amber-500 p-3 text-sm">
          NOC pages need a sign-in with a passkey. An email link is not enough.
        </p>
      )}
      <section className="space-y-2">
        <PasskeySignIn next={admin ? '/admin' : noc ? '/noc' : siteHome(site)} />
      </section>
      <section className="space-y-2">
        <h2 className="font-medium">{nocSite ? 'First sign-in, or no passkey on this device?' : 'No passkey on this device?'}</h2>
        <MagicLinkForm />
      </section>
      {!nocSite && (
        <p className="text-sm">
          New here?{' '}
          <Link href="/sign-up" className="text-brand underline">
            Sign up
          </Link>
        </p>
      )}
    </div>
  );
}
