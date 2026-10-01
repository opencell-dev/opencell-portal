import { asc } from 'drizzle-orm';
import type { Metadata } from 'next';
import { NocRoleForm } from '@/components/noc-role-form';
import { PromoteForm } from '@/components/promote-form';
import { users } from '@/db/schema';
import { appCtx } from '@/lib/ctx';
import { rolesOf } from '@/lib/users';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Accounts' };

export default async function AdminUsers() {
  await requireAdmin();
  const ctx = appCtx();
  const rows = ctx.db.select().from(users).orderBy(asc(users.id)).all();
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Accounts</h1>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className="py-2 pr-4">Id</th>
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Email</th>
              <th className="py-2">Roles</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-1 pr-4">{u.id}</td>
                <td className="py-1 pr-4">{u.name}</td>
                <td className="py-1 pr-4">{u.email}</td>
                <td className="py-1">{rolesOf(ctx, u.id).join(', ') || 'unverified'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
