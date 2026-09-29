import type { Metadata } from 'next';
import Link from 'next/link';
import { listAudit } from '@/lib/audit';
import { coreStatusOrNull } from '@/lib/core-status';
import { appCtx } from '@/lib/ctx';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Admin' };

export default async function Admin() {
  const { user } = await requireAdmin();
  const ctx = appCtx();
  const core = await coreStatusOrNull(ctx, user.id);
  const audit = listAudit(ctx, 20);
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Core</h2>
        {core ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <dt className="text-slate-500">Name</dt>
            <dd>{core.name}</dd>
            <dt className="text-slate-500">Version</dt>
            <dd>{core.version}</dd>
            <dt className="text-slate-500">Cells online</dt>
            <dd>
              {core.cellsOnline} / {core.cellsTotal}
            </dd>
            <dt className="text-slate-500">Subscribers</dt>
            <dd>{core.subscribers}</dd>
          </dl>
        ) : (
          <p className="text-sm text-red-700 dark:text-red-400">Core unreachable</p>
        )}
      </section>
      <p>
        <Link href="/admin/users" className="text-brand underline">
          Accounts and admins
        </Link>
      </p>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Recent portal actions</h2>
        <ul className="space-y-1 font-mono text-xs">
          {audit.map((a) => (
            <li key={a.id}>
              {new Date(a.at).toISOString()} {a.actorId ?? '-'} {a.action} {a.target ?? ''}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
