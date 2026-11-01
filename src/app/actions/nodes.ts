'use server';

import { redirect } from 'next/navigation';
import { AGREEMENT_VERSION } from '@/content/operator-agreement';
import { acceptAgreement, samePath } from '@/lib/agreement';
import { appCtx } from '@/lib/ctx';
import { requestMeta, requireUser } from '@/server/request';

// The operator's actions (portal spec §6). Each checks the session itself
// first, and the services find a node or request among the session's own, so
// someone else's is "no such node", never a hint that it exists.

/** "I accept" on /nodes/agreement: the current version, then on to where the sign-in was going. */
export async function acceptAgreementAction(form: FormData): Promise<void> {
  const { user } = await requireUser();
  acceptAgreement(appCtx(), user.id, AGREEMENT_VERSION, await requestMeta());
  const next = form.get('next');
  redirect(samePath(typeof next === 'string' ? next : '') ?? '/nodes');
}
