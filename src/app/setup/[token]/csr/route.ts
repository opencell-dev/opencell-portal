import { appCtx } from '@/lib/ctx';
import { handleCsr } from '@/lib/nodes/setup';

export const dynamic = 'force-dynamic';

/** A CSR with the setup token (portal spec §6.3): the script sends Origin, so the proxy's origin check holds. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return handleCsr(appCtx(), (await params).token, req);
}
