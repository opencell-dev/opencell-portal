import type { Metadata } from 'next';
import Link from 'next/link';
import { RequestForm } from '@/components/nodes/request-form';
import { AGREEMENT_VERSION } from '@/content/operator-agreement';
import { appCtx } from '@/lib/ctx';
import { canRequest, MAX_OPEN_REQUESTS, REGION_CODES } from '@/lib/nodes/requests';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Request a base station' };

export default async function RequestNode() {
  const { user } = await requireUser();
  return (
    <div className="space-y-6">
      <p>
        <Link href="/nodes" className="text-sm underline">
          ← Nodes
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Request a base station</h1>
      <p className="max-w-2xl">
        A node is a Raspberry Pi and an OpenCell radio that carry calls for the people around it. An admin reads every request and may ask you a question first. Once it is approved, one command on
        the Pi sets it up.
      </p>
      {canRequest(appCtx(), user.id) ? (
        <RequestForm regions={REGION_CODES} agreementVersion={AGREEMENT_VERSION} />
      ) : (
        <p role="status">You have {MAX_OPEN_REQUESTS} requests waiting. An admin will answer those first.</p>
      )}
    </div>
  );
}
