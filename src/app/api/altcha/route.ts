import { newChallenge } from '@/lib/captcha';
import { appCtx } from '@/lib/ctx';

export const dynamic = 'force-dynamic';

/** A fresh ALTCHA challenge for the sign-up form's widget. */
export async function GET() {
  return Response.json(await newChallenge(appCtx()), { headers: { 'Cache-Control': 'no-store' } });
}
