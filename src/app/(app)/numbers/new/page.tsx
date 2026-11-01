import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PlaceSearch } from '@/components/numbers/place-search';
import { confirmHref } from '@/lib/numbers/format';
import { appCtx } from '@/lib/ctx';
import { MAX_TYPED, parseTyped } from '@/lib/numbers/input';
import { capsOf, syncDue } from '@/lib/numbers/ownership';
import { searchPlaces } from '@/lib/numbers/places';
import { hit } from '@/lib/ratelimit';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Get a number' };

/** Get a number, step 1 "Where?" (portal spec §4.1). */
export default async function NewNumber({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { user } = await requireUser();
  const ctx = appCtx();
  const raw = (await searchParams).q;
  const q = (typeof raw === 'string' ? raw : '').slice(0, MAX_TYPED);
  // A whole number typed and searched without JavaScript: straight to the confirm step.
  const typed = q.trim() === '' ? null : parseTyped(q);
  if (typed?.kind === 'number') redirect(confirmHref(typed.number));
  // What the core says now: an activation since the last look frees a waiting slot.
  await syncDue(ctx, user.id);
  const caps = capsOf(ctx, user.id);
  return (
    <div className="max-w-2xl space-y-6">
      <p>
        <Link href="/numbers" className="text-sm underline">
          ← My numbers
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Get a number</h1>
      {!caps.canGet && (
        <p role="note" className="rounded border border-amber-500 p-3 text-sm">
          {caps.why === 'unactivated'
            ? 'You have 3 numbers waiting for activation. Activate or release one before you get another.'
            : `You hold ${caps.held} numbers, your account's limit. You can ask for more on My numbers.`}
        </p>
      )}
      <p className="text-slate-600 dark:text-slate-300">
        OpenCell numbers use real exchanges: +883 1, then a place's area code and exchange, then 5 digits. Find a place,
        or type the whole number you want.
      </p>
      {/* Searched without JavaScript (with it, /api/places answers as they type): the same limit. */}
      <PlaceSearch q={q} places={q.trim() !== '' && hit(ctx, 'places_account', String(user.id)).ok ? searchPlaces(ctx, q) : []} />
    </div>
  );
}
