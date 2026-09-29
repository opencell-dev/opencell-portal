import { sql } from 'drizzle-orm';
import { appCtx } from '@/lib/ctx';

export const dynamic = 'force-dynamic';

/** For the deploy script and monitoring: the database answers, and which build this is. */
export function GET() {
  appCtx().db.get(sql`select 1`);
  return Response.json({ ok: true, version: process.env.OC_VERSION ?? 'dev' }, { headers: { 'Cache-Control': 'no-store' } });
}
