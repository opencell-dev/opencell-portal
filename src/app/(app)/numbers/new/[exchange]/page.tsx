import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { appCtx } from '@/lib/ctx';
import { sideLabel } from '@/lib/numbers/homing';
import { drawFree } from '@/lib/numbers/browse';
import { confirmHref, exchangeLabel, fromSegment, otherWindow, shortlistHref, spacedNumber } from '@/lib/numbers/format';
import { exchangeOffered, exchangesOfPlace } from '@/lib/numbers/places';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Choose a number' };

/** How many of a place's other exchanges one page lists (a rate center can have thousands). */
const OTHERS = 12;

/** Get a number, step 2 "Choose" (portal spec §4.1): 8 random free numbers in one exchange. */
export default async function Shortlist({
  params,
  searchParams,
}: {
  params: Promise<{ exchange: string }>;
  searchParams: Promise<{ draw?: string | string[]; others?: string | string[] }>;
}) {
  const { user } = await requireUser();
  const ctx = appCtx();
  const exchange = fromSegment((await params).exchange);
  const place = exchangeOffered(ctx, exchange);
  if (!place) notFound();
  const sp = await searchParams;
  const rawDraw = sp.draw;
  const draw = Math.min(Math.max(Number.parseInt(typeof rawDraw === 'string' ? rawDraw : '1', 10) || 1, 1), 1_000_000);
  const free = await drawFree(ctx, user.id, exchange);
  const others = exchangesOfPlace(ctx, place.region, place.rateCenter).filter((e) => e !== exchange);
  const nearby = otherWindow(others, Number.parseInt(typeof sp.others === 'string' ? sp.others : '0', 10), OTHERS);
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
      {!free.ok ? (
        <p role="alert" className="text-red-600">
          {free.error}
        </p>
      ) : free.numbers.length === 0 ? (
        <p>This exchange has no free numbers left. Try another exchange in this area.</p>
      ) : (
        <ul aria-label="Free numbers" className="grid gap-2 sm:grid-cols-2">
          {free.numbers.map((n) => (
            <li key={n}>
              <Link
                href={confirmHref(n)}
                prefetch={false}
                className="block rounded border border-slate-300 px-3 py-2 font-mono hover:border-brand dark:border-slate-700"
              >
                {spacedNumber(n)}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link href={`${shortlistHref(exchange)}?draw=${draw + 1}`} prefetch={false} className="underline">
          Show others
        </Link>
      </p>
      {others.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Other exchange in this area</h2>
          <ul className="flex flex-wrap gap-2">
            {nearby.shown.map((e) => (
              <li key={e}>
                <Link href={shortlistHref(e)} prefetch={false} className="rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700">
                  {exchangeLabel(e)}
                </Link>
              </li>
            ))}
          </ul>
          {nearby.next !== null && (
            <p className="text-sm">
              <Link href={`${shortlistHref(exchange)}?others=${nearby.next}`} prefetch={false} className="underline">
                More exchanges
              </Link>{' '}
              <span className="text-slate-500">({others.length} in all)</span>
            </p>
          )}
        </section>
      )}
      <p className="text-sm text-slate-500">
        Want a particular number? <Link href="/numbers/new" className="underline">Type it on the search page</Link>.
      </p>
    </div>
  );
}
