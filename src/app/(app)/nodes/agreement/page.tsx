import type { Metadata } from 'next';
import Link from 'next/link';
import { acceptAgreementAction } from '@/app/actions/nodes';
import { ConfirmButton } from '@/components/confirm-button';
import { AgreementText } from '@/components/nodes/agreement-text';
import { AGREEMENT_VERSION } from '@/content/operator-agreement';
import { acceptedVersion, samePath } from '@/lib/agreement';
import { appCtx } from '@/lib/ctx';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Base Station Operator Agreement' };

/** Re-acceptance at sign-in (portal spec §6.4): the current text and one button. Nodes keep running meanwhile. */
export default async function NodeAgreement({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { user } = await requireUser();
  const { next } = await searchParams;
  const to = samePath(typeof next === 'string' ? next : '') ?? '/nodes';
  const accepted = (acceptedVersion(appCtx(), user.id) ?? 0) >= AGREEMENT_VERSION;
  return (
    <article className="space-y-4">
      <h1 className="text-2xl font-semibold">Base Station Operator Agreement</h1>
      <p className="text-sm text-slate-500">Version {AGREEMENT_VERSION}, non-binding</p>
      <AgreementText />
      {accepted ? (
        <p role="status">
          You have accepted this version.{' '}
          <Link href={to} className="text-brand underline">
            Carry on
          </Link>
        </p>
      ) : (
        <form action={acceptAgreementAction} className="space-y-2">
          <input type="hidden" name="next" value={to} />
          <p className="text-sm">The agreement has changed since you last accepted it. Your nodes keep running either way.</p>
          <ConfirmButton label="I accept" />
        </form>
      )}
    </article>
  );
}
