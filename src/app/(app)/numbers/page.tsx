import type { Metadata } from 'next';
import { GetNumberCard } from '@/components/numbers/get-number-card';
import { LiveNumbers } from '@/components/numbers/live-numbers';
import { appCtx } from '@/lib/ctx';
import { pendingRequestOf } from '@/lib/numbers/limits';
import { capsOf } from '@/lib/numbers/ownership';
import { placeOfNumber } from '@/lib/numbers/places';
import { accountStatus } from '@/lib/numbers/status';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'My numbers' };

/** My numbers (portal spec §5): a card per number, live, and the "＋ Get a number" card. */
export default async function Numbers() {
  const { user } = await requireUser();
  const ctx = appCtx();
  // Synced first (at most 3 s, P2 decision 3), so the page opens with what the core says now.
  const status = await accountStatus(ctx, user.id);
  const caps = capsOf(ctx, user.id);
  const cards = status.map((s) => ({ number: s.number, place: placeOfNumber(ctx, s.number) }));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">My numbers</h1>
      {status.length === 0 && <p className="text-slate-600 dark:text-slate-300">Hello {user.name}. You have no numbers yet.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <LiveNumbers key={cards.map((c) => c.number).join(',')} cards={cards} initial={status} fake={ctx.config.core === 'fake'} />
        <GetNumberCard held={caps.held} limit={caps.limit} why={caps.why} pending={pendingRequestOf(ctx, user.id) !== undefined} />
      </div>
    </div>
  );
}
