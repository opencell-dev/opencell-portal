import type { Metadata } from 'next';
import Link from 'next/link';
import { AgreementText } from '@/components/nodes/agreement-text';
import { AGREEMENT_VERSION } from '@/content/operator-agreement';
import { agreementStats, operatorsBehind } from '@/lib/agreement';
import { appCtx } from '@/lib/ctx';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Agreement versions' };

/** The Base Station Operator Agreement (portal spec §6.4): the current text, acceptances per version, and who is behind. */
export default async function AdminAgreement() {
  await requireAdmin();
  const ctx = appCtx();
  const stats = agreementStats(ctx);
  const behind = operatorsBehind(ctx);
  return (
    <div className="max-w-3xl space-y-6">
      <p>
        <Link href="/admin" className="text-sm underline">
          ← Admin
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Agreement versions</h1>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Acceptances</h2>
        {stats.length === 0 ? (
          <p className="text-sm">None yet.</p>
        ) : (
          <ul className="text-sm">
            {stats.map((s) => (
              <li key={s.version}>
                Version {s.version}: {s.accepted}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Operators on an older version</h2>
        {behind.length === 0 ? (
          <p className="text-sm">None.</p>
        ) : (
          <ul className="text-sm">
            {behind.map((o) => (
              <li key={o.userId}>
                {o.name} ({o.email}): {o.version === null ? 'none accepted' : `version ${o.version}`}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Version {AGREEMENT_VERSION}, the current text</h2>
        <AgreementText />
      </section>
    </div>
  );
}
