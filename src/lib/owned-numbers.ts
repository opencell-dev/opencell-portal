import type { Ctx } from '@/lib/ctx';
import { listNumbers } from '@/lib/numbers/ownership';

export interface OwnedNumber {
  number: string;
  activated: boolean;
}

/** The numbers an account holds (the `numbers` table, portal P2), oldest first: what deleting the account must decide about. */
export function ownedNumbers(ctx: Ctx, userId: number): OwnedNumber[] {
  return listNumbers(ctx, userId).map((r) => ({ number: r.number, activated: r.state === 'activated' }));
}
