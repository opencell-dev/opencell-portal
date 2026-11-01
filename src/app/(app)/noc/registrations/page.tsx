import type { Metadata } from 'next';
import { RegistrationPager } from '@/components/noc/registration-pager';
import { appCtx } from '@/lib/ctx';
import { registrationsPage } from '@/lib/noc/registrations';
import { requestMeta, requireNoc } from '@/server/request';

export const metadata: Metadata = { title: 'Registrations · NOC' };

const SELECT = 'rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900';

/**
 * Who is registered on a core now (reg.list, plan N2a), by number, with each
 * terminal's signal; ?core=&cell= (no numbers in the URL: later pages are
 * POSTs). Read under the viewer's account and audited.
 */
export default async function NocRegistrations({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requireNoc();
  const ctx = appCtx();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const core = ctx.cores.find((c) => c.id === one(sp.core))?.id ?? ctx.cores[0].id;
  const cellText = one(sp.cell);
  const cellId = cellText && /^[1-9]\d{0,9}$/.test(cellText) && Number(cellText) <= 0xffffffff ? Number(cellText) : undefined;
  const page = await registrationsPage(ctx, { core, cellId }, user.id, (await requestMeta()).ip);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Registrations</h1>
        <p className="text-xs text-slate-500">Read under your account; the portal and the core record it.</p>
      </div>
      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">Core</span>
          <select name="core" defaultValue={core} className={SELECT}>
            {ctx.cores.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">Cell id</span>
          <input name="cell" defaultValue={cellId ?? ''} inputMode="numeric" maxLength={10} className={`${SELECT} w-24`} />
        </label>
        <button type="submit" className="rounded border border-slate-300 px-3 py-1 dark:border-slate-700">
          Show
        </button>
      </form>
      {page.rows.state === 'ok' ? (
        <RegistrationPager key={`${core}-${cellId ?? 0}`} core={core} cellId={cellId} first={page.rows.value} more={page.more} now={ctx.now()} />
      ) : page.rows.state === 'unsupported' ? (
        <p className="text-sm text-slate-500">{core} does not list registrations (reg.list needs oc-core v0.4.0).</p>
      ) : (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {core} did not answer in time{cellId !== undefined ? ', or has no such cell' : ''}.
        </p>
      )}
    </div>
  );
}
