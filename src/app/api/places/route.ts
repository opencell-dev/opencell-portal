import { appCtx } from '@/lib/ctx';
import { MAX_TYPED } from '@/lib/numbers/input';
import { searchPlaces } from '@/lib/numbers/places';
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
  return Response.json({ places: searchPlaces(appCtx(), q) }, { headers: NO_STORE });
}
