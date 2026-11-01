import type { Metadata } from 'next';
import Link from 'next/link';
import { LocalTime } from '@/components/numbers/local-time';
import { appCtx } from '@/lib/ctx';
import { requestStatusLabel } from '@/lib/nodes/labels';
import { reviewQueue } from '@/lib/nodes/review';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Node requests' };

/** The review queue (portal spec §6.2), oldest first. */
export default async function AdminRequests() {
  await requireAdmin();
  const rows = reviewQueue(appCtx());
  return (
    <div className="space-y-6">
      <p>
        <Link href="/admin" className="text-sm underline">
          ← Admin
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Node requests</h1>
      {rows.length === 0 ? (
        <p>No request is waiting.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-300 p-4 dark:border-slate-700" data-testid="node-request">
              <p className="font-medium">
                <Link href={`/admin/requests/${r.id}`} className="text-brand underline">
                  {r.siteName}
                </Link>{' '}
                ({r.region})
              </p>
              <p className="text-sm">{r.requester}</p>
              <p className="text-sm text-slate-500">
                {r.status === 'question' ? 'Waiting for the requester' : requestStatusLabel(r.status)} · sent <LocalTime t={r.createdAt} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
