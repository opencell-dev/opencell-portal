import { sql } from 'drizzle-orm';
import { appCtx } from '@/lib/ctx';

export const dynamic = 'force-dynamic';

/**
 * For the deploy script and monitoring: the database answers, which build
 * this is, and which site (M1, final review) — so a deploy to the wrong
 * guest, or a guest whose portal.env is missing OC_SITE=noc, is caught as
 * unhealthy instead of quietly going live as the wrong site.
 */
export function GET() {
  const ctx = appCtx();
  ctx.db.get(sql`select 1`);
  return Response.json(
    { ok: true, version: process.env.OC_VERSION ?? 'dev', site: ctx.config.site },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
