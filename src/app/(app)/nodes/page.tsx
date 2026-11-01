import type { Metadata } from 'next';
import Link from 'next/link';
import { NodeCardView } from '@/components/nodes/node-card';
import { AutoRefresh } from '@/components/noc/auto-refresh';
import { LocalTime } from '@/components/numbers/local-time';
import { needsAgreement } from '@/lib/agreement';
import { appCtx } from '@/lib/ctx';
import { requestStatusLabel } from '@/lib/nodes/labels';
import { myNodes } from '@/lib/nodes/my-nodes';
import { canRequest, listMyRequests } from '@/lib/nodes/requests';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Nodes' };

/** My nodes (portal spec §6.3): a card per node, the account's requests, and "Request a node". */
export default async function Nodes() {
  const { user } = await requireUser();
  const ctx = appCtx();
  const cards = await myNodes(ctx, user.id);
  const requests = listMyRequests(ctx, user.id);
  const now = ctx.now();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Nodes</h1>
      {needsAgreement(ctx, user.id) && (
        <p role="status" className="rounded border border-amber-500 p-3 text-sm">
          The Base Station Operator Agreement has changed.{' '}
          <Link href="/nodes/agreement?next=%2Fnodes" className="text-brand underline">
            Please read and accept it
          </Link>
          . Your nodes keep running meanwhile.
        </p>
      )}
      {cards.length === 0 && requests.length === 0 && (
        <p>
          You don&apos;t host a base station. Hosting one means keeping a Raspberry Pi and an OpenCell radio running for the people around you. Read the{' '}
          <Link href="/operator-agreement" className="text-brand underline">
            Base Station Operator Agreement
          </Link>{' '}
          to see what it asks.
        </p>
      )}
      {cards.length > 0 && (
        <>
          <ul className="grid gap-4 md:grid-cols-2">
            {cards.map((c) => (
              <li key={c.id}>
                <NodeCardView c={c} now={now} />
              </li>
            ))}
          </ul>
          <AutoRefresh seconds={15} />
        </>
      )}
      {canRequest(ctx, user.id) && (
        <p>
          <Link href="/nodes/request" className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark">
            Request a node
          </Link>
        </p>
      )}
      {requests.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Your requests</h2>
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} data-testid="my-request">
                <Link href={`/nodes/requests/${r.id}`} className="text-brand underline">
                  {r.siteName}
                </Link>{' '}
                — {requestStatusLabel(r.status)} <span className="text-sm text-slate-500">(<LocalTime t={r.createdAt} />)</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
