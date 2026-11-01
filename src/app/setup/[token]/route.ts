import { appCtx } from '@/lib/ctx';
import { handleScript } from '@/lib/nodes/setup';

export const dynamic = 'force-dynamic';

/** The setup script (portal spec §6.3): the token in the path is the bearer; no session. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return handleScript(appCtx(), (await params).token, req);
}
