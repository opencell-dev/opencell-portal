import { and, asc, eq, isNotNull, or, sql } from 'drizzle-orm';
import { numbers, users } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';
import { MAX_TYPED } from './input';

// The directory (portal spec §5): names and numbers of subscribers who are
// listed, for signed-in subscribers only (never the public or search engines,
// §10). Listing is opt-out: the account switch (users.directoryListed) is the
// master, each number's own box (numbers.listed, the confirm step) the
// detail (P2 decision 1). A waiting number is nobody's yet, so it is never
// shown; nor is a disabled one.

export const DIRECTORY_PAGE = 50;

const likeAny = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function directory(ctx: Ctx, q: string, page: number): { rows: { name: string; number: string }[]; more: boolean } {
  const query = q.normalize('NFKC').trim();
  if (query.length > MAX_TYPED) return { rows: [], more: false };
  const p = Number.isInteger(page) && page >= 1 ? page : 1;
  const digits = query.replace(/[\s\-().+]/g, '');
  const byDigits = /^\d+$/.test(digits) ? digits.replace(/^8831/, '') : null;
  const match =
    query === ''
      ? undefined
      : or(
          sql`lower(${users.name}) LIKE lower(${likeAny(query)}) ESCAPE '\\'`,
          byDigits ? sql`${numbers.number} LIKE ${likeAny(byDigits)} ESCAPE '\\'` : undefined,
        );
  const rows = ctx.db
    .select({ name: users.name, number: numbers.number })
    .from(numbers)
    .innerJoin(users, eq(users.id, numbers.userId))
    .where(
      and(
        eq(users.directoryListed, true),
        isNotNull(users.emailVerifiedAt),
        eq(numbers.listed, true),
        eq(numbers.state, 'activated'),
        eq(numbers.disabled, false),
        match,
      ),
    )
    .orderBy(asc(users.name), asc(numbers.number))
    .limit(DIRECTORY_PAGE + 1)
    .offset((p - 1) * DIRECTORY_PAGE)
    .all();
  return { rows: rows.slice(0, DIRECTORY_PAGE), more: rows.length > DIRECTORY_PAGE };
}
