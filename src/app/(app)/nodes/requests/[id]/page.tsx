import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { replyAction, withdrawRequestAction } from '@/app/actions/nodes';
import { WithdrawForm } from '@/components/nodes/request-status';
import { MessageForm, Thread } from '@/components/nodes/thread';
import { LocalTime } from '@/components/numbers/local-time';
import { appCtx } from '@/lib/ctx';
import { requestStatusLabel } from '@/lib/nodes/labels';
import { getMyRequest } from '@/lib/nodes/requests';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Your base station request' };

/** One of the account's own requests: its details and the thread with the admins. Anyone else's is a 404. */
export default async function MyRequest({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireUser();
  const id = Number((await params).id);
  const r = Number.isSafeInteger(id) && id > 0 ? getMyRequest(appCtx(), user.id, id) : null;
  if (!r) notFound();
  const open = r.status === 'pending' || r.status === 'question';
  return (
    <div className="max-w-2xl space-y-6">
      <p>
        <Link href="/nodes" className="text-sm underline">
          ← Nodes
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">{r.siteName}</h1>
      <p role="status" data-testid="request-status">
        {requestStatusLabel(r.status)}
      </p>
      {r.status === 'declined' && r.declineNote && <p className="whitespace-pre-wrap rounded border border-slate-300 p-3 dark:border-slate-700">{r.declineNote}</p>}
      {r.status === 'approved' && r.nodeId !== null && (
        <p>
          <Link href={`/nodes/${r.nodeId}`} className="text-brand underline">
            Set up your node
          </Link>
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">Position</dt>
        <dd>
          {r.lat}, {r.lon} ({r.region})
        </dd>
        <dt className="text-slate-500">Hardware</dt>
        <dd>
          {r.piModel}, {r.w12Boards} W12 board{r.w12Boards === 1 ? '' : 's'}
          {r.gps ? ', GPS' : ''}; {r.antenna}
        </dd>
        <dt className="text-slate-500">Contact phone</dt>
        <dd>{r.contactPhone}</dd>
        <dt className="text-slate-500">Sent</dt>
        <dd>
          <LocalTime t={r.createdAt} />
        </dd>
      </dl>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Messages</h2>
        <Thread rows={r.thread} viewer="requester" />
        {open && <MessageForm action={replyAction} id={r.id} label="Your reply" button="Send" />}
      </section>
      {open && <WithdrawForm id={r.id} action={withdrawRequestAction} />}
    </div>
  );
}
