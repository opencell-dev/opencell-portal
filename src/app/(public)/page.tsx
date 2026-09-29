import Link from 'next/link';
import { currentSession } from '@/server/request';

export default async function Home() {
  const s = await currentSession();
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">A phone network run by its neighbours</h1>
      <p className="text-lg text-slate-600 dark:text-slate-300">
        OpenCell is a community radio phone network. Get a number, activate your OpenCell terminal with a QR code, and
        call anyone on the network. People who host a base station keep it running for everyone around them.
      </p>
      <div className="flex flex-wrap gap-3">
        {s ? (
          <Link href="/numbers" className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark">
            Go to my numbers
          </Link>
        ) : (
          <>
            <Link href="/sign-up" className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark">
              Sign up
            </Link>
            <Link href="/sign-in" className="rounded border border-slate-300 px-4 py-2 dark:border-slate-700">
              Sign in
            </Link>
          </>
        )}
        <Link href="/coverage" className="rounded border border-slate-300 px-4 py-2 dark:border-slate-700">
          Coverage
        </Link>
      </div>
    </div>
  );
}
