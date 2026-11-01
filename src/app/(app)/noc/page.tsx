import type { Metadata } from 'next';
import Link from 'next/link';
import { ActivityTiles, CallMix } from '@/components/noc/activity';
import { AutoRefresh } from '@/components/noc/auto-refresh';
import { AttentionList, CoreTable, KpiTiles, NotReported } from '@/components/noc/overview';
import { When } from '@/components/noc/status';
import { appCtx } from '@/lib/ctx';
import { cachedActivity, summarizeActivity } from '@/lib/noc/activity';
import { cachedSnapshot, summarize } from '@/lib/noc/snapshot';
import { requireNoc } from '@/server/request';

export const metadata: Metadata = { title: 'NOC' };

/** "Is OpenCell working right now?" (NOC design §9.1): live from every core's admin API, nothing stored. */
export default async function NocOverview() {
  await requireNoc();
  const ctx = appCtx();
  const snap = await cachedSnapshot(ctx);
  const s = summarize(snap);
  const a = summarizeActivity(await cachedActivity(ctx, snap));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Network overview</h1>
        <p className="flex items-center gap-3 text-xs text-slate-500">
          <span>
            Live from the cores, asked <When t={snap.at} now={ctx.now()} />
          </span>
          <AutoRefresh />
        </p>
      </div>
      <KpiTiles s={s}>
        <ActivityTiles a={a} />
      </KpiTiles>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Cores</h2>
        <CoreTable cores={snap.cores} />
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Needs attention</h2>
        <AttentionList items={s.attention} />
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">
          Calls, last 24 h{' '}
          <Link href="/noc/calls" prefetch={false} className="text-sm font-normal text-brand underline">
            all calls
          </Link>
        </h2>
        <CallMix s={a.calls} />
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Not reported yet</h2>
        <NotReported />
      </section>
    </div>
  );
}
