import { appCtx } from '@/lib/ctx';
import { accountStatus } from '@/lib/numbers/status';
import { currentSession } from '@/server/request';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * The live status of the session's own numbers, for My numbers' cards
 * (portal spec §4.1 step 4, §5; P2 decision 3: polled, every 5 s while a
 * number is waiting or unregistered, else every 30 s). Only ever the
 * session's account: there is no parameter to name another.
 */
export async function GET() {
  const s = await currentSession();
  if (!s) return Response.json({ error: 'Please sign in.' }, { status: 401, headers: NO_STORE });
  return Response.json({ numbers: await accountStatus(appCtx(), s.user.id) }, { headers: NO_STORE });
}
