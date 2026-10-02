import Link from 'next/link';
import { signOut } from '@/app/actions/session';
import type { Site } from '@/lib/site';

// The links to pages behind Anubis's proof of work (deploy/anubis/) never
// prefetch: this header is also on the emailed-link page, whose own Anubis
// pass a background request to one of them would replace, and the Confirm
// button's POST would then meet a challenge instead of the portal. (The
// public pages Anubis lets through prefetch as usual.) The NOC's site
// (NOC design §N1.5) has no public page at all, so nothing there prefetches.
export function SiteHeader({ signedIn, site }: { signedIn: boolean; site: Site }) {
  if (site === 'noc') {
    return (
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link href="/noc" prefetch={false} className="flex-1 text-lg font-semibold text-brand">
            OpenCell NOC
          </Link>
          <div className="flex items-center gap-3 text-sm">
            {signedIn ? (
              <>
                <Link href="/account" prefetch={false} className="hover:underline">
                  Account
                </Link>
                <form action={signOut}>
                  <button type="submit" className="rounded border border-slate-300 px-3 py-1 dark:border-slate-700">
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <Link href="/sign-in" prefetch={false} className="hover:underline">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>
    );
  }
  return (
    <header className="border-b border-slate-200 dark:border-slate-800">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="text-lg font-semibold text-brand">
          OpenCell
        </Link>
        <nav className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <Link href="/coverage" className="hover:underline">
            Coverage
          </Link>
          <Link href="/operator-agreement" className="hover:underline">
            Operate a base station
          </Link>
        </nav>
        <div className="flex items-center gap-3 text-sm">
          {signedIn ? (
            <>
              <Link href="/numbers" prefetch={false} className="hover:underline">
                My numbers
              </Link>
              <form action={signOut}>
                <button type="submit" className="rounded border border-slate-300 px-3 py-1 dark:border-slate-700">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <>
              <Link href="/sign-in" prefetch={false} className="hover:underline">
                Sign in
              </Link>
              <Link href="/sign-up" prefetch={false} className="rounded bg-brand px-3 py-1 font-medium text-white hover:bg-brand-dark">
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
