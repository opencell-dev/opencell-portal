import type { Metadata } from 'next';
import Link from 'next/link';
import { appCtx } from '@/lib/ctx';
import { directory } from '@/lib/numbers/directory';
import { spacedNumber } from '@/lib/numbers/format';
import { MAX_TYPED } from '@/lib/numbers/input';
import { requireUser } from '@/server/request';

// Signed-in only, and never for search engines (portal spec §5, §10).
export const metadata: Metadata = { title: 'Directory', robots: { index: false, follow: false } };

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');

/** The directory (portal spec §5): listed subscribers' names and numbers, searchable. */
export default async function Directory({ searchParams }: { searchParams: Promise<{ q?: string | string[]; page?: string | string[] }> }) {
  const { user } = await requireUser();
  const ctx = appCtx();
  const sp = await searchParams;
  const q = one(sp.q).slice(0, MAX_TYPED);
  const page = Math.max(1, Number.parseInt(one(sp.page), 10) || 1);
  const { rows, more } = directory(ctx, q, page);
  const href = (p: number) => `/directory?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Directory</h1>
      <p className="text-slate-600 dark:text-slate-300">
        Subscribers who chose to be listed, with their names and numbers. Only signed-in subscribers can see it.
      </p>
      <p className="text-sm text-slate-500">
        You are {user.directoryListed ? 'listed' : 'not listed'}: change it on your <Link href="/account" className="underline">Account</Link> page.
      </p>
      <form method="get" role="search" className="flex flex-wrap items-end gap-2">
        <label className="flex-1 text-sm">
          <span className="font-medium">Name or number</span>
          <input
            name="q"
            defaultValue={q}
            maxLength={MAX_TYPED}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <button type="submit" className="rounded border border-slate-300 px-4 py-2 dark:border-slate-700">
          Search
        </button>
      </form>
      {rows.length === 0 ? (
        <p>{q ? 'Nobody listed matches.' : 'Nobody is listed yet.'}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className="py-2 pr-4">Name</th>
              <th className="py-2">Number</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.number} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-1 pr-4">{r.name}</td>
                <td className="py-1 font-mono">{spacedNumber(r.number)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="flex gap-4 text-sm">
        {page > 1 && (
          <Link href={href(page - 1)} className="underline">
            ← Previous
          </Link>
        )}
        {more && (
          <Link href={href(page + 1)} className="underline">
            Next →
          </Link>
        )}
      </p>
    </div>
  );
}
