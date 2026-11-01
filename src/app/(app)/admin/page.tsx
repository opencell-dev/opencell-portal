import type { Metadata } from 'next';
import Link from 'next/link';
import { CoreCards } from '@/components/core-cards';
import { listAudit } from '@/lib/audit';
import { coreStatuses } from '@/lib/core-status';
import { appCtx } from '@/lib/ctx';
import { pendingLimitRequests } from '@/lib/numbers/limits';
import { recentRefreshes } from '@/lib/numbers/nanpa-refresh';
import { coreActor } from '@/lib/site';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Admin' };

export default async function Admin() {
  const { user } = await requireAdmin();
  const ctx = appCtx();
  const cores = await coreStatuses(ctx, coreActor(ctx.config.site, user.id));
  const audit = listAudit(ctx, 20);
  const portal = ctx.config.site === 'portal';
  const waiting = portal ? pendingLimitRequests(ctx).length : 0;
  const refreshes = portal ? recentRefreshes(ctx, 5) : [];
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <CoreCards rows={cores} />
      <p className="flex flex-wrap gap-x-6">
        <Link href="/admin/users" className="text-brand underline">
          Accounts and admins
        </Link>
        {portal && (
          <Link href="/admin/limits" className="text-brand underline">
            Requests for more numbers{waiting > 0 ? ` (${waiting})` : ''}
          </Link>
        )}
        {ctx.config.site === 'noc' && (
          <Link href="/noc" prefetch={false} className="text-brand underline">
            Network operations (NOC)
          </Link>
        )}
      </p>
      {portal && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">NANPA refreshes</h2>
          {refreshes.length === 0 ? (
            <p className="text-sm">None yet: run oc-portal-admin nanpa-refresh on the guest (the weekly timer does it on Sundays).</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {refreshes.map((r) => (
                <li key={r.id}>
                  {new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')} UTC: {r.summary}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
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
