import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Nodes' };

export default async function Nodes() {
  await requireUser();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Nodes</h1>
      <p className="text-slate-600 dark:text-slate-300">You don’t host a base station.</p>
      <p>
        Hosting one means keeping a Raspberry Pi and an OpenCell radio running for the people around you. Read the{' '}
        <Link href="/operator-agreement" className="text-brand underline">
          Base Station Operator Agreement
        </Link>{' '}
        to see what it asks; requests open in the portal soon.
      </p>
    </div>
  );
}
