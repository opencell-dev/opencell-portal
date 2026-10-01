import type { Metadata } from 'next';
import { AutoRefresh } from '@/components/noc/auto-refresh';
import { StatusDot, When } from '@/components/noc/status';
import { Topology } from '@/components/noc/topology';
import { appCtx } from '@/lib/ctx';
import { cachedSnapshot } from '@/lib/noc/snapshot';
import { layoutTopology } from '@/lib/noc/topology';
import { requireNoc } from '@/server/request';

export const metadata: Metadata = { title: 'Topology · NOC' };

/** Cores, their cells and the backhaul between them (NOC design §9.2). A cell's number is its registered terminals. */
export default async function NocTopology() {
  await requireNoc();
  const ctx = appCtx();
  const snap = await cachedSnapshot(ctx);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Topology</h1>
        <p className="flex items-center gap-3 text-xs text-slate-500">
          <span>
            Asked <When t={snap.at} now={ctx.now()} />
          </span>
          <AutoRefresh />
        </p>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <StatusDot tone="ok" label="Online / linked" />
        <StatusDot tone="warn" label="Offline" />
        <StatusDot tone="bad" label="Unreachable" />
        <StatusDot tone="info" label="Never connected" />
        <StatusDot tone="off" label="Revoked, or not reported" />
        <span className="text-slate-500">Number in a cell: terminals registered. Dashed grey between cores: OCSS, not reported yet.</span>
      </p>
      <Topology t={layoutTopology(snap)} />
      <p className="text-xs text-slate-500">
        Radios per cell and the database layer join this view when the cores report them (cell.radio; plan N4).
      </p>
    </div>
  );
}
