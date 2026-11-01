import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { askWithin } from '@/lib/core-ask';
import { appCtx } from '@/lib/ctx';
import { sideLabel } from '@/lib/numbers/homing';
import { confirmHref, exchangeLabel, fromSegment, shortlistHref, spacedNumber } from '@/lib/numbers/format';
import { CORE_DEADLINE_MS } from '@/lib/numbers/ownership';
import { exchangeOffered, exchangesOfPlace } from '@/lib/numbers/places';
import { coreFor } from '@/lib/numbers/route';
import { coreActor } from '@/lib/site';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Choose a number' };

/** The shortlist size (spec §4.1 step 2: 8 random free numbers). */
const SHORTLIST = 8;

/** Get a number, step 2 "Choose" (portal spec §4.1): 8 random free numbers in one exchange. */
export default async function Shortlist({
  params,
  searchParams,
}: {
  params: Promise<{ exchange: string }>;
  searchParams: Promise<{ draw?: string | string[] }>;
}) {
  const { user } = await requireUser();
  const ctx = appCtx();
  const exchange = fromSegment((await params).exchange);
  const place = exchangeOffered(ctx, exchange);
  if (!place) notFound();
  const rawDraw = (await searchParams).draw;
  const draw = Math.min(Math.max(Number.parseInt(typeof rawDraw === 'string' ? rawDraw : '1', 10) || 1, 1), 1_000_000);
  const h = coreFor(ctx, exchange);
  const free = await askWithin(h, 'num.free', () => h.core.numFree(coreActor(ctx.config.site, user.id), exchange, SHORTLIST), CORE_DEADLINE_MS);
  const others = exchangesOfPlace(ctx, place.region, place.rateCenter).filter((e) => e !== exchange);
  return (
    <div className="max-w-2xl space-y-6">
      <p>
        <Link href="/numbers/new" className="text-sm underline">
          ← Another place
        </Link>
      </p>
      <div>
        <h1 className="text-2xl font-semibold">
          {place.display}, {place.region} ({exchangeLabel(exchange)})
        </h1>
        <p className="text-sm text-slate-500">Served by {sideLabel(place.side)}</p>
      </div>
      {free === null ? (
        <p role="alert" className="text-red-600">
          The network didn&apos;t answer. Please try again in a minute.
        </p>
      ) : free.length === 0 ? (
        <p>This exchange has no free numbers left. Try another exchange in this area.</p>
      ) : (
        <ul aria-label="Free numbers" className="grid gap-2 sm:grid-cols-2">
          {free.map((n) => (
            <li key={n}>
              <Link
                href={confirmHref(n)}
                className="block rounded border border-slate-300 px-3 py-2 font-mono hover:border-brand dark:border-slate-700"
              >
                {spacedNumber(n)}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link href={`${shortlistHref(exchange)}?draw=${draw + 1}`} className="underline">
          Show others
        </Link>
      </p>
      {others.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Other exchange in this area</h2>
          <ul className="flex flex-wrap gap-2">
            {others.map((e) => (
              <li key={e}>
                <Link href={shortlistHref(e)} className="rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700">
                  {exchangeLabel(e)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-sm text-slate-500">
        Want a particular number? <Link href="/numbers/new" className="underline">Type it on the search page</Link>.
      </p>
    </div>
  );
}
