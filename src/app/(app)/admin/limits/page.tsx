import type { Metadata } from 'next';
import Link from 'next/link';
import { LimitDecision } from '@/components/limit-decision';
import { appCtx } from '@/lib/ctx';
import { MAX_LIMIT, pendingLimitRequests } from '@/lib/numbers/limits';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Requests for more numbers' };

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Requests for more numbers (portal spec §4.2; P2 decision 5): the account's history, then raise or decline. */
export default async function AdminLimits() {
  await requireAdmin();
  const ctx = appCtx();
  const pending = pendingLimitRequests(ctx);
  return (
    <div className="space-y-6">
      <p>
        <Link href="/admin" className="text-sm underline">
          ← Admin
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Requests for more numbers</h1>
      {pending.length === 0 ? (
        <p>No request is waiting.</p>
      ) : (
        <ul className="space-y-6">
          {pending.map((p) => (
            <li key={p.id} className="space-y-3 rounded-lg border border-slate-300 p-4 dark:border-slate-700" data-testid="limit-request">
              <div>
                <p className="font-medium">
                  {p.name} · {p.email}
                </p>
                <p className="text-sm text-slate-500">
                  Email {p.verified ? 'verified' : 'not verified'} · subscriber since {day(p.subscriberSince)} · holds {p.held} of{' '}
                  {p.limit} · asks for {p.wanted} in all · asked {day(p.createdAt)}
                </p>
              </div>
              <blockquote className="whitespace-pre-line border-l-4 border-slate-300 pl-3 dark:border-slate-700">{p.reason}</blockquote>
              {p.history.length > 0 && (
                <ul className="text-sm text-slate-500">
                  {p.history.map((h) => (
                    <li key={h.decidedAt}>
                      {day(h.decidedAt)}: {h.outcome}
                      {h.note ? ` (${h.note})` : ''}
                    </li>
                  ))}
                </ul>
              )}
              <LimitDecision id={p.id} limit={p.limit} wanted={p.wanted} max={MAX_LIMIT} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
