import type { Metadata } from 'next';
import Link from 'next/link';
import { AgreementText } from '@/components/nodes/agreement-text';
import { AGREEMENT_VERSION } from '@/content/operator-agreement';

export const metadata: Metadata = { title: 'Base Station Operator Agreement' };

export default function OperatorAgreement() {
  return (
    <article className="space-y-4">
      <h1 className="text-2xl font-semibold">Base Station Operator Agreement</h1>
      <p className="text-sm text-slate-500">Version {AGREEMENT_VERSION}, non-binding</p>
      <AgreementText />
      <p className="text-sm text-slate-500">
        To host a base station, sign in and{' '}
        <Link href="/nodes/request" prefetch={false} className="text-brand underline">
          request a node
        </Link>
        ; you accept this agreement when you send the request.
      </p>
    </article>
  );
}
