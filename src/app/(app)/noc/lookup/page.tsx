import type { Metadata } from 'next';
import { NumberLookup } from '@/components/noc/number-lookup';
import { asFakeCore } from '@/core/fake';
import { DEMO_SITES } from '@/core/fake-demo';
import { groupNumber } from '@/lib/noc/format';
import { appCtx } from '@/lib/ctx';
import { requireNoc } from '@/server/request';

export const metadata: Metadata = { title: 'Number lookup · NOC' };

/**
 * The echo and playback numbers (network-core §22) are marked "service" in
 * the call list. Core 1's and core 2's are fixed by the deployment; the demo
 * adds its sites' echo numbers.
 */
const SERVICE = ['+883160655500100', '+883160655500101', '+883150355500100', '+883150355500101'];

/**
 * Staff: admins and NOC operators (ruling 2026-10-01 #8/#9 overrides portal
 * spec §10: a number's status and calls, unmasked, for admins and NOC
 * operators alike). NOC design §9.5.
 */
export default async function NocLookup() {
  await requireNoc();
  const ctx = appCtx();
  const fake = ctx.config.core === 'fake';
  const service = fake ? [...SERVICE, ...DEMO_SITES.map((s) => s.echo)] : SERVICE;
  const first = asFakeCore(ctx.cores[0]?.core);
  const tryThese = fake && first ? first.numbers().slice(0, 3) : [];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Number lookup</h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        A number&apos;s state, registration and calls of the last 30 days, from the core that holds numbers. Each lookup is recorded
        in the portal&apos;s audit and the core&apos;s.
      </p>
      {tryThese.length > 0 && (
        <p className="text-sm text-slate-500">
          Demo numbers to try: <span className="font-mono">{tryThese.map(groupNumber).join(', ')}</span>
        </p>
      )}
      <NumberLookup serviceNumbers={service} />
    </div>
  );
}
