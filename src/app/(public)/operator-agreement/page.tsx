import type { Metadata } from 'next';
import { AGREEMENT, AGREEMENT_VERSION } from '@/content/operator-agreement';

export const metadata: Metadata = { title: 'Base Station Operator Agreement' };

export default function OperatorAgreement() {
  return (
    <article className="space-y-4">
      <h1 className="text-2xl font-semibold">Base Station Operator Agreement</h1>
      <p className="text-sm text-slate-500">Version {AGREEMENT_VERSION}, non-binding</p>
      <p>
        <strong>{AGREEMENT.lead}</strong> {AGREEMENT.intro}
      </p>
      <p>{AGREEMENT.promise}</p>
      <ol className="list-decimal space-y-2 pl-6">
        {AGREEMENT.items.map(([title, text]) => (
          <li key={title}>
            <strong>{title}</strong> {text}
          </li>
        ))}
      </ol>
      <p>{AGREEMENT.closing}</p>
      <p className="text-sm text-slate-500">
        Requests to host a base station open in the portal soon; you will accept this agreement when you send one.
      </p>
    </article>
  );
}
