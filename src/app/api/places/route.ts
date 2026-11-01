import { appCtx } from '@/lib/ctx';
import { MAX_TYPED } from '@/lib/numbers/input';
import { searchPlaces } from '@/lib/numbers/places';
import { hit } from '@/lib/ratelimit';
import { currentSession } from '@/server/request';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Place suggestions for "Where?" (portal spec §4.1), for the search box as
 * the subscriber types. Signed-in only: a JSON 401 otherwise (a route
 * handler answers fetch(), so no redirect). Read-only, so a GET.
 */
export async function GET(req: Request) {
  const s = await currentSession();
  if (!s) return Response.json({ error: 'Please sign in.' }, { status: 401, headers: NO_STORE });
  const q = new URL(req.url).searchParams.get('q') ?? '';
  if (q.length > MAX_TYPED) return Response.json({ places: [] }, { headers: NO_STORE });
  const ctx = appCtx();
  const lim = hit(ctx, 'places_account', String(s.user.id));
  if (!lim.ok) return Response.json({ places: [], error: lim.message }, { status: 429, headers: NO_STORE });
  return Response.json({ places: searchPlaces(ctx, q) }, { headers: NO_STORE });
}
