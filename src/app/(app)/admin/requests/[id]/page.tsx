import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { askAction, declineAction } from '@/app/actions/admin-nodes';
import { ApproveForm } from '@/components/nodes/approve-form';
import { MessageForm, Thread } from '@/components/nodes/thread';
import { LocalTime } from '@/components/numbers/local-time';
import { appCtx } from '@/lib/ctx';
import { requestStatusLabel } from '@/lib/nodes/labels';
import { reviewDetail } from '@/lib/nodes/review';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Node request' };

const BACKHAUL = { home: 'Home internet', cellular: 'Cellular', other: 'Other' };
const POWER = { mains: 'Mains', mains_battery: 'Mains and battery', solar: 'Solar' };

/** One request (portal spec §6.2): the history, the site with its exact pin and phone, the nearest cell, the target core, the thread, and the decisions. */
export default async function AdminRequest({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const id = Number((await params).id);
  const d = Number.isSafeInteger(id) && id > 0 ? reviewDetail(appCtx(), id) : null;
  if (!d) notFound();
  const r = d.request;
  const open = r.status === 'pending' || r.status === 'question';
  const u = d.requester;
  return (
    <div className="max-w-3xl space-y-6">
      <p>
        <Link href="/admin/requests" className="text-sm underline">
          ← Node requests
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">{r.siteName}</h1>
      <p role="status" data-testid="request-status">
        {r.status === 'question' ? 'Waiting for the requester' : requestStatusLabel(r.status)}
        {r.declineNote ? `: ${r.declineNote}` : ''}
        {r.nodeId !== null ? `: node ${r.nodeId}` : ''}
      </p>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">The requester</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Account</dt>
          <dd>
            <Link href={`/admin/users/${u.id}`} className="text-brand underline">
              {u.name}
            </Link>{' '}
            ({u.email}){u.disabled ? ' — disabled' : ''}
          </dd>
          <dt className="text-slate-500">Subscriber since</dt>
          <dd>
            <LocalTime t={u.since} />
          </dd>
          <dt className="text-slate-500">Email verified</dt>
          <dd>{u.verifiedAt ? <LocalTime t={u.verifiedAt} /> : 'No'}</dd>
          <dt className="text-slate-500">Numbers</dt>
          <dd>
            {u.numbers} held, {u.activated} activated
          </dd>
          <dt className="text-slate-500">Requests</dt>
          <dd>
            {u.requests.pending + u.requests.question} open, {u.requests.approved} approved, {u.requests.declined} declined, {u.requests.withdrawn} withdrawn
          </dd>
        </dl>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">The site</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Exact pin</dt>
          <dd data-testid="exact-pin">
            {r.lat}, {r.lon}
          </dd>
          <dt className="text-slate-500">State or province</dt>
          <dd>{r.region}</dd>
          <dt className="text-slate-500">Hardware</dt>
          <dd>
            {r.piModel}, {r.w12Boards} W12 board{r.w12Boards === 1 ? '' : 's'}, {r.gps ? 'GPS fitted' : 'no GPS'}
          </dd>
          <dt className="text-slate-500">Antenna</dt>
          <dd>{r.antenna}</dd>
          <dt className="text-slate-500">Backhaul</dt>
          <dd>{BACKHAUL[r.backhaul]}</dd>
          <dt className="text-slate-500">Power</dt>
          <dd>{POWER[r.power]}</dd>
          <dt className="text-slate-500">Contact phone</dt>
          <dd>{r.contactPhone}</dd>
          <dt className="text-slate-500">Agreement</dt>
          <dd>
            Version {r.agreementVersion}, accepted <LocalTime t={r.agreedAt} />
          </dd>
          <dt className="text-slate-500">Nearest cell</dt>
          <dd>{d.nearestNode ? `${d.nearestNode.cellName}, ${d.nearestNode.km.toFixed(1)} km` : 'None yet'}</dd>
          <dt className="text-slate-500">Nearest rate center</dt>
          <dd>
            {d.rateCenter ? `${d.rateCenter.name}, ${d.rateCenter.region} (${d.rateCenter.km.toFixed(1)} km)` : 'Unknown'}
            {d.rateCenter && !d.rateCenter.matches && (
              <strong className="ml-2 text-amber-700 dark:text-amber-400" data-testid="state-mismatch">
                The pin looks to be in {d.rateCenter.region}, not {r.region}.
              </strong>
            )}
          </dd>
          <dt className="text-slate-500">Target core</dt>
          <dd>
            {d.target.coreId ?? 'None'}
            {d.target.side ? ` (${d.target.side === 'east' ? 'East' : 'West'})` : ''}
            {d.target.note ? ` — ${d.target.note}` : ''}
          </dd>
        </dl>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Questions</h2>
        <Thread rows={d.thread} viewer="admin" />
        {open && <MessageForm action={askAction} id={r.id} label="Ask a question (it is emailed)" button="Ask" />}
      </section>
      {open && (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Approve</h2>
            <p className="text-sm">Adds the cell to its core in Part 15, makes a 24 h setup command and emails it. It asks for your passkey.</p>
            <ApproveForm id={r.id} cores={d.cores} coreId={d.target.coreId} anchor={d.suggestedAnchor} boardRole={r.gps ? 'bs' : 'bench'} />
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Decline</h2>
            <MessageForm action={declineAction} id={r.id} label="The note (it is emailed)" button="Decline" />
          </section>
        </>
      )}
    </div>
  );
}
