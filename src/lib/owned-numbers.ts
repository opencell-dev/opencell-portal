import type { Ctx } from '@/lib/ctx';

export interface OwnedNumber {
  number: string;
  activated: boolean;
}

/**
 * The numbers an account holds. P1 has no number ownership table yet
 * (get-a-number is P2), so every account holds none; P2 replaces this body
 * with a query of its `numbers` table.
 */
export function ownedNumbers(_ctx: Ctx, _userId: number): OwnedNumber[] {
  return [];
}
