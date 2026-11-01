import type { Metadata } from 'next';
import Link from 'next/link';
import { CoreCards } from '@/components/core-cards';
import { listAudit } from '@/lib/audit';
import { cellCaInfo } from '@/lib/ca/cell-ca';
import { coreStatuses } from '@/lib/core-status';
import { appCtx } from '@/lib/ctx';
import { pendingLimitRequests } from '@/lib/numbers/limits';
import { recentRefreshes } from '@/lib/numbers/nanpa-refresh';
import { currentRelease } from '@/lib/nodes/release';
import { waitingRequests } from '@/lib/nodes/review';
import { offlineCount } from '@/lib/nodes/watch';
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
  const requests = portal ? waitingRequests(ctx) : 0;
  const offline = portal ? offlineCount(ctx) : 0;
  const ca = cellCaInfo(ctx);
  const release = portal ? currentRelease(ctx) : null;
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <CoreCards rows={cores} />
      <p className="flex flex-wrap gap-x-6">
        <Link href="/admin/users" className="text-brand underline">
          Accounts and admins
        </Link>
        {portal && (
          <>
            <Link href="/admin/requests" className="text-brand underline">
              Node requests{requests > 0 ? ` (${requests})` : ''}
            </Link>
            <Link href="/admin/cells" className="text-brand underline">
              Cells{offline > 0 ? ` (${offline} offline)` : ''}
            </Link>
            <Link href="/admin/numbers" className="text-brand underline">
              Numbers and blocks
            </Link>
            <Link href="/admin/calls" prefetch={false} className="text-brand underline">
              Call records
            </Link>
            <Link href="/admin/audit" className="text-brand underline">
              Audit log
            </Link>
            <Link href="/admin/agreement" className="text-brand underline">
              Agreement versions
            </Link>
            <Link href="/admin/limits" className="text-brand underline">
              Requests for more numbers{waiting > 0 ? ` (${waiting})` : ''}
            </Link>
          </>
        )}
        {ctx.config.site === 'noc' && (
          <Link href="/noc" prefetch={false} className="text-brand underline">
            Network operations (NOC)
          </Link>
        )}
      </p>
      {portal && (
        <section className="space-y-1 text-sm" data-testid="cell-ca">
          <h2 className="text-lg font-semibold">Node setup</h2>
          <p>
            Cell intermediate CA:{' '}
            {!ca.configured
              ? 'not configured, so no certificates are issued.'
              : 'problem' in ca
                ? ca.problem
                : `valid until ${new Date(ca.notAfter).toISOString().slice(0, 10)}${ca.notAfter - ctx.now() < 30 * 86_400_000 ? ': renew it now (deploy/oc-portal-cell-ca renew)' : ''}, fingerprint ${ca.fpr}.`}
          </p>
          <p>Cell software: {release ? `${release.tag} is published.` : 'nothing is published, so setup commands wait (deploy/oc-portal-cell-release).'}</p>
        </section>
      )}
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
