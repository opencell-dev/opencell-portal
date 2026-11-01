import { appCtx } from '@/lib/ctx';
import { handleTarball } from '@/lib/nodes/setup';

export const dynamic = 'force-dynamic';

/** The published oc-cell source the setup script builds (plan P3, decision 3). */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return handleTarball(appCtx(), (await params).token, req);
}
