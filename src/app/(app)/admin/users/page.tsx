import type { Metadata } from 'next';
import Link from 'next/link';
import { NocRoleForm } from '@/components/noc-role-form';
import { PromoteForm } from '@/components/promote-form';
import { searchSubscribers } from '@/lib/admin/subscribers';
import { appCtx } from '@/lib/ctx';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Accounts' };

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');

/** The accounts (portal spec §1): search by name, email or digits of a number. */
export default async function AdminUsers({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const ctx = appCtx();
  const portal = ctx.config.site === 'portal';
  const sp = await searchParams;
  const q = one(sp.q);
  const page = Number(one(sp.page)) || 1;
  const { rows, more } = searchSubscribers(ctx, q, page);
  const at = (p: number) => `/admin/users?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Accounts</h1>
      <form method="get" className="flex max-w-md items-end gap-2">
        <label className="flex-1 text-sm">
          <span className="font-medium">Search by name, email or number</span>
          <input name="q" defaultValue={q} maxLength={64} className="mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
        </label>
        <button type="submit" className="rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
          Search
        </button>
      </form>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className="py-2 pr-4">Id</th>
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Email</th>
              <th className="py-2 pr-4">Numbers</th>
              <th className="py-2">Roles</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-1 pr-4">{u.id}</td>
                <td className="py-1 pr-4">
                  {portal ? (
                    <Link href={`/admin/users/${u.id}`} className="text-brand underline">
                      {u.name}
                    </Link>
                  ) : (
                    u.name
                  )}
                </td>
                <td className="py-1 pr-4">{u.email}</td>
                <td className="py-1 pr-4">{u.numbers}</td>
                <td className="py-1">
                  {u.roles.join(', ') || 'unverified'}
                  {u.disabled ? ' (disabled)' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(page > 1 || more) && (
        <p className="flex gap-4 text-sm">
          {page > 1 && (
            <Link href={at(page - 1)} className="underline">
              ← Previous
            </Link>
          )}
          {more && (
            <Link href={at(page + 1)} className="underline">
              Next →
            </Link>
          )}
        </p>
      )}
      <section className="max-w-md space-y-2">
        <h2 className="text-lg font-semibold">Make an admin</h2>
        <PromoteForm />
      </section>
      {ctx.config.site === 'noc' && (
        <section className="max-w-md space-y-2">
          <h2 className="text-lg font-semibold">NOC operators</h2>
          <p className="text-sm text-slate-500">
            A NOC operator sees the NOC (cores, cells, topology, number lookup) but not the admin pages, accounts or the demo controls.
          </p>
          <NocRoleForm />
        </section>
      )}
    </div>
  );
}
