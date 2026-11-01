import type { Metadata } from 'next';
import Link from 'next/link';
import { auditPage } from '@/lib/audit';
import { appCtx } from '@/lib/ctx';
import { cachedActivity } from '@/lib/noc/activity';
import { coreAuditView } from '@/lib/noc/core-audit';
import { exact } from '@/lib/noc/format';
import { cachedSnapshot } from '@/lib/noc/snapshot';
import { requestMeta, requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Audit log' };

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');
const input = 'mt-1 w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900';

/** The portal's audit, filtered and paged, and one core's audit beside it, matched to the portal's rows. */
export default async function AdminAudit({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requireAdmin();
  const ctx = appCtx();
  const sp = await searchParams;
  const action = one(sp.action).slice(0, 64);
  const target = one(sp.target).slice(0, 128);
  const actor = /^\d{1,15}$/.test(one(sp.actor)) ? Number(one(sp.actor)) : undefined;
  const before = /^\d{1,15}$/.test(one(sp.before)) ? Number(one(sp.before)) : undefined;
  const { rows, next } = auditPage(ctx, { action: action || undefined, target: target || undefined, actor, before });
  const core = ctx.cores.find((h) => h.id === one(sp.core))?.id;
  let coreView = null;
  if (core) {
    await cachedActivity(ctx, await cachedSnapshot(ctx));
    coreView = await coreAuditView(ctx, core, user.id, (await requestMeta()).ip);
  }
  const nextHref = next === null ? null : `/admin/audit?${new URLSearchParams({ ...(action ? { action } : {}), ...(target ? { target } : {}), ...(actor !== undefined ? { actor: String(actor) } : {}), before: String(next) })}`;
  return (
    <div className="space-y-6">
      <p>
        <Link href="/admin" className="text-sm underline">
          ← Admin
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <form method="get" className="grid max-w-2xl gap-3 text-sm sm:grid-cols-4">
        <label className="block">
          <span className="font-medium">Action</span>
          <input name="action" defaultValue={action} className={input} />
        </label>
        <label className="block">
          <span className="font-medium">Account id</span>
          <input name="actor" defaultValue={actor ?? ''} inputMode="numeric" className={input} />
        </label>
        <label className="block">
          <span className="font-medium">Target</span>
          <input name="target" defaultValue={target} className={input} />
        </label>
        <div className="flex items-end">
          <button type="submit" className="rounded border border-slate-300 px-3 py-1 dark:border-slate-700">
            Filter
          </button>
        </div>
      </form>
      <ul className="space-y-1 font-mono text-xs" data-testid="audit-rows">
        {rows.map((a) => (
          <li key={a.id}>
            {new Date(a.at).toISOString()} {a.actorId ?? '-'} {a.action} {a.target ?? ''} {a.detail ?? ''}
          </li>
        ))}
      </ul>
      {nextHref && (
        <p className="text-sm">
          <Link href={nextHref} className="underline">
            Older →
          </Link>
        </p>
      )}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">A core&apos;s own audit</h2>
        <p className="flex flex-wrap gap-3 text-sm">
          {ctx.cores.map((h) => (
            <Link key={h.id} href={`/admin/audit?core=${h.id}`} prefetch={false} className="underline">
              {h.id}
            </Link>
          ))}
        </p>
        {coreView && coreView.records.state !== 'ok' && <p role="status">{coreView.records.state === 'unsupported' ? `${core} does not report its audit.` : `${core} didn't answer, or its audit has not been read yet. Try again in a minute.`}</p>}
        {coreView?.records.state === 'ok' && (
          <ul className="space-y-1 font-mono text-xs" data-testid="core-audit">
            {coreView.records.value.map((c) => (
              <li key={c.record.id}>
                {exact(c.record.at)} {c.who?.kind === 'this-site' ? (coreView.emails[c.who.userId] ?? `account ${c.who.userId}`) : c.who?.kind === 'polls' ? 'the portal' : ''} {c.record.detail}
                {c.portal.length > 0 ? ` ← ${c.portal.map((p) => p.action).join(', ')}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
