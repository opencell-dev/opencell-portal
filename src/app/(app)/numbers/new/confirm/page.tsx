import type { Metadata } from 'next';
import Link from 'next/link';
import { isAssignable } from '@/core/numbers';
import { isCoreError } from '@/core/types';
import { GetNumberForm } from '@/components/numbers/qr-actions';
import { tryWithin } from '@/lib/core-ask';
import { appCtx } from '@/lib/ctx';
import { sideLabel } from '@/lib/numbers/homing';
import { activateHref, exchangeLabel, shortlistHref, spacedNumber } from '@/lib/numbers/format';
import { parseTyped } from '@/lib/numbers/input';
import { CORE_DEADLINE_MS, capsOf, numberOf } from '@/lib/numbers/ownership';
import { exchangeOffered, whyNotOffered } from '@/lib/numbers/places';
import { coreFor } from '@/lib/numbers/route';
import { coreActor } from '@/lib/site';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Confirm your number' };

/** The rule, word for word (portal spec §4.1 step 3). */
const RULE = "This number is yours only once a terminal activates it. If it isn't activated within 3 days, it goes back to the pool.";

function Problem({ children, back = '/numbers/new' }: { children: React.ReactNode; back?: string }) {
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Confirm your number</h1>
      <p role="alert">{children}</p>
      <p>
        <Link href={back} className="underline">
          Pick another
        </Link>
      </p>
    </div>
  );
}

/** Get a number, step 3 "Confirm" (portal spec §4.1): the number, the place, the serving core, the rule, the directory box. */
export default async function Confirm({ searchParams }: { searchParams: Promise<{ number?: string | string[] }> }) {
  const { user } = await requireUser();
  const ctx = appCtx();
  const raw = (await searchParams).number;
  const typed = parseTyped(typeof raw === 'string' ? raw : '');
  if (typed.kind !== 'number') return <Problem>{typed.kind === 'bad' ? typed.message : 'Type a whole number, like 717-464-12345.'}</Problem>;
  const number = typed.number;
  const exchange = number.slice(0, 11);
  if (numberOf(ctx, user.id, number)) {
    return (
      <Problem back={activateHref(number)}>
        You already have {spacedNumber(number)}.
      </Problem>
    );
  }
  if (!isAssignable(number)) {
    return <Problem>{spacedNumber(number)} cannot be given out: its last five digits must be 01000 to 99998 (and not 09911).</Problem>;
  }
  const why = whyNotOffered(ctx, exchange);
  const place = exchangeOffered(ctx, exchange);
  if (why || !place) return <Problem>{why}</Problem>;
  const h = coreFor(ctx, number);
  const check = await tryWithin(h, 'num.check', () => h.core.numCheck(coreActor(ctx.config.site, user.id), number), CORE_DEADLINE_MS);
  if (!check.ok) {
    const notOpen = !('late' in check) && isCoreError(check.error) && check.error.code === 'not_assignable';
    return <Problem back={shortlistHref(exchange)}>{notOpen ? "Numbers in this area code aren't open yet." : "The network didn't answer. Please try again in a minute."}</Problem>;
  }
  if (check.value === 'taken') return <Problem back={shortlistHref(exchange)}>Someone has this number. Pick another.</Problem>;
  if (check.value === 'not_assignable') return <Problem>Numbers in this area code aren&apos;t open yet.</Problem>;
  const caps = capsOf(ctx, user.id);
  return (
    <div className="max-w-2xl space-y-6">
      <p>
        <Link href={shortlistHref(exchange)} className="text-sm underline">
          ← Other numbers in {exchangeLabel(exchange)}
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Confirm your number</h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-slate-500">Number</dt>
        <dd className="font-mono text-lg" data-testid="confirm-number">
          {spacedNumber(number)}
        </dd>
        <dt className="text-slate-500">Place</dt>
        <dd>
          {place.display}, {place.region}
        </dd>
        <dt className="text-slate-500">Served by</dt>
        <dd>{sideLabel(place.side)}</dd>
      </dl>
      <p className="rounded border border-slate-300 p-3 dark:border-slate-700" data-testid="rule">
        {RULE}
      </p>
      {caps.canGet ? (
        <GetNumberForm number={number} />
      ) : (
        <p role="note" className="rounded border border-amber-500 p-3 text-sm">
          {caps.why === 'unactivated'
            ? 'You have 3 numbers waiting for activation. Activate or release one first.'
            : `You hold ${caps.held} numbers, your account's limit. Ask for more on My numbers.`}{' '}
          <Link href="/numbers" className="underline">
            My numbers
          </Link>
        </p>
      )}
    </div>
  );
}
