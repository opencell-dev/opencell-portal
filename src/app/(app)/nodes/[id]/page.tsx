import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NodeCardView } from '@/components/nodes/node-card';
import { AlertsSwitch, CancelDowntimeButton, DowntimeForm, RetireForm, SimulateNode } from '@/components/nodes/node-forms';
import { SetupCommand } from '@/components/nodes/setup-command';
import { AutoRefresh } from '@/components/noc/auto-refresh';
import { LocalTime } from '@/components/numbers/local-time';
import { needsAgreement } from '@/lib/agreement';
import { appCtx } from '@/lib/ctx';
import { getMyNode, myNodeRow } from '@/lib/nodes/my-nodes';
import { currentRelease } from '@/lib/nodes/release';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Your node' };

/** One of the account's own nodes: the card, setup, alerts, downtime, retire. Anyone else's is a 404. */
export default async function MyNode({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireUser();
  const ctx = appCtx();
  const id = Number((await params).id);
  const c = Number.isSafeInteger(id) && id > 0 ? await getMyNode(ctx, user.id, id) : null;
  const row = c && myNodeRow(ctx, user.id, id);
  if (!c || !row) notFound();
  const revoked = c.state === 'revoked';
  const release = currentRelease(ctx);
  return (
    <div className="max-w-3xl space-y-8">
      <p>
        <Link href="/nodes" className="text-sm underline">
          ← Nodes
        </Link>
      </p>
      {needsAgreement(ctx, user.id) && (
        <p role="status" className="rounded border border-amber-500 p-3 text-sm">
          The Base Station Operator Agreement has changed.{' '}
          <Link href={`/nodes/agreement?next=${encodeURIComponent(`/nodes/${id}`)}`} className="text-brand underline">
            Please read and accept it
          </Link>
          . Your node keeps running meanwhile.
        </p>
      )}
      <NodeCardView c={c} now={ctx.now()} link={false} />
      {!revoked && <AutoRefresh seconds={15} />}
      <p className="text-sm text-slate-500">
        Exact position, for you and the admins only: {row.lat}, {row.lon} ({row.region})
      </p>
      {ctx.config.core === 'fake' && !revoked && c.cert && <SimulateNode id={id} online={c.state === 'online'} />}
      {!revoked && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Setup</h2>
          {c.cert ? (
            <p className="text-sm">
              Certificate <code className="break-all font-mono text-xs">{c.cert.fpr}</code>, valid until <LocalTime t={c.cert.expiresAt} />.
            </p>
          ) : (
            <p className="text-sm">This node has no certificate yet. Run the setup command on the Pi.</p>
          )}
          {c.setup && (
            <p className="text-sm">
              A setup command works until <LocalTime t={c.setup.expiresAt} />. It is in your email; a new one stops it.
            </p>
          )}
          {release ? <SetupCommand id={id} hasCert={c.cert !== null} /> : <p role="status">Setup opens when the cell software is published.</p>}
        </section>
      )}
      {!revoked && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Alerts</h2>
          <AlertsSwitch id={id} muted={c.alertsMuted} />
        </section>
      )}
      {!revoked && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Downtime notices</h2>
          <p className="text-sm">Planned maintenance or a move? No alert fires inside a notice, and the admins see it.</p>
          {c.downtime.length > 0 && (
            <ul className="space-y-2">
              {c.downtime.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <span>
                    <LocalTime t={w.startsAt} /> to <LocalTime t={w.endsAt} />: {w.reason}
                  </span>
                  <CancelDowntimeButton id={w.id} />
                </li>
              ))}
            </ul>
          )}
          <DowntimeForm id={id} />
        </section>
      )}
      {!revoked && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Retire this node</h2>
          <p className="text-sm">The hardware stays yours. The admins revoke the node&apos;s cell when it is time.</p>
          <RetireForm id={id} />
        </section>
      )}
    </div>
  );
}
