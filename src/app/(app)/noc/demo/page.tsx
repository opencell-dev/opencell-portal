import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { type DemoCore, DemoControls } from '@/components/noc/demo-controls';
import { asFakeCore } from '@/core/fake';
import { appCtx } from '@/lib/ctx';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Demo controls · NOC' };

/** Admin only, on the NOC's site, and only on the fake core (NOC design §10, §N1.5): a 404 in production. */
export default async function NocDemo() {
  await requireAdmin();
  const ctx = appCtx();
  if (ctx.config.site !== 'noc' || ctx.config.core !== 'fake') notFound();
  const cores: DemoCore[] = [];
  for (const h of ctx.cores) {
    const fake = asFakeCore(h.core);
    if (fake) cores.push({ id: h.id, down: fake.isDown, cells: fake.simCells() });
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Demo controls</h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        These change the fake cores in this portal process only. Nothing reaches a real core, and a restart forgets them.
      </p>
      <DemoControls cores={cores} />
    </div>
  );
}
