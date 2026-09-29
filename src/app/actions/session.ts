'use server';

import { redirect } from 'next/navigation';
import { writeAudit } from '@/lib/audit';
import { appCtx } from '@/lib/ctx';
import { endSession, sessionFromToken } from '@/lib/sessions';
import { clearSessionCookie, requestMeta, sessionToken } from '@/server/request';

/** Sign out: the session row goes, then the cookie (spec §3). */
export async function signOut(): Promise<void> {
  const token = await sessionToken();
  if (token) {
    const ctx = appCtx();
    const s = sessionFromToken(ctx, token);
    endSession(ctx, token);
    if (s) writeAudit(ctx, { actorId: s.user.id, action: 'session.end', target: `user:${s.user.id}`, ip: (await requestMeta()).ip });
  }
  await clearSessionCookie();
  redirect('/');
}
