import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DisableAccountForm, EnableAccountButton, FinishDisablingButton, NumberDisabledButton } from '@/components/admin/subscriber-controls';
import { LocalTime } from '@/components/numbers/local-time';
import { subscriberDetail } from '@/lib/admin/subscribers';
import { appCtx } from '@/lib/ctx';
import { groupNumber } from '@/lib/noc/format';
import { requestStatusLabel } from '@/lib/nodes/labels';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Account' };

/** One subscriber: their numbers, requests and nodes, and disabling (portal spec §10). */
export default async function AdminUser({ params }: { params: Promise<{ id: string }> }) {
  const { user: me } = await requireAdmin();
  const ctx = appCtx();
  if (ctx.config.site !== 'portal') notFound();
  const id = Number((await params).id);
  const d = Number.isSafeInteger(id) && id > 0 ? subscriberDetail(ctx, id) : null;
  if (!d) notFound();
  return (
    <div className="max-w-3xl space-y-6">
      <p>
        <Link href="/admin/users" className="text-sm underline">
          ← Accounts
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">{d.user.name}</h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">Email</dt>
        <dd>
          {d.user.email} {d.user.emailVerifiedAt ? '(verified)' : '(not verified)'}
        </dd>
        <dt className="text-slate-500">Subscriber since</dt>
        <dd>
          <LocalTime t={d.user.createdAt} />
        </dd>
        <dt className="text-slate-500">Roles</dt>
        <dd>{d.roles.join(', ') || 'none'}</dd>
        <dt className="text-slate-500">Open sessions</dt>
        <dd>{d.sessions}</dd>
        <dt className="text-slate-500">Agreement</dt>
        <dd>{d.agreement === null ? 'Not accepted' : `Version ${d.agreement}`}</dd>
        <dt className="text-slate-500">State</dt>
        <dd data-testid="account-state">
          {d.user.disabledAt === null ? (
            'Enabled'
          ) : (
            <>
              Disabled <LocalTime t={d.user.disabledAt} />
            </>
          )}
        </dd>
      </dl>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Numbers</h2>
        {d.numbers.length === 0 ? (
          <p className="text-sm">None.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {d.numbers.map((n) => (
              <li key={n.number} className="flex flex-wrap items-center gap-3">
                <span className="font-mono">{groupNumber(n.number)}</span>
                <span>{n.disabled ? `disabled${n.disabledBy ? ` (by the ${n.disabledBy})` : ''}` : n.state}</span>
                <NumberDisabledButton number={n.number} disabled={n.disabled} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Base stations</h2>
        {d.requests.length === 0 && d.nodes.length === 0 && <p className="text-sm">None.</p>}
        <ul className="space-y-1 text-sm">
          {d.requests.map((r) => (
            <li key={`r${r.id}`}>
              Request{' '}
              <Link href={`/admin/requests/${r.id}`} className="text-brand underline">
                {r.siteName}
              </Link>
              : {requestStatusLabel(r.status)}
            </li>
          ))}
          {d.nodes.map((n) => (
            <li key={`n${n.id}`}>
              Node {n.id}: {n.siteName}, cell {n.cellId} on {n.coreId}
              {n.revokedAt !== null ? ' (revoked)' : ''}
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Disabling</h2>
        <p className="text-sm">It ends the account&apos;s sessions and disables its numbers. Its nodes keep running: revoking a cell is its own action. Both ask for your passkey.</p>
        {d.user.id === me.id ? (
          <p className="text-sm">This is your own account.</p>
        ) : d.user.disabledAt === null ? (
          <>
            {/* A core that did not answer leaves numbers behind: each step can be run again (decision 22). */}
            {d.numbers.some((n) => n.disabledBy === 'account') && <EnableAccountButton id={d.user.id} label="Finish enabling: some numbers are still off" />}
            <DisableAccountForm id={d.user.id} />
          </>
        ) : (
          <>
            {d.numbers.some((n) => !n.disabled) && <FinishDisablingButton id={d.user.id} email={d.user.email} />}
            <EnableAccountButton id={d.user.id} label="Enable this account" />
          </>
        )}
      </section>
    </div>
  );
}
