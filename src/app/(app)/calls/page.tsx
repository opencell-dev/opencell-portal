import type { Metadata } from 'next';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Calls' };

export default async function Calls() {
  await requireUser();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Calls</h1>
      <p className="text-slate-600 dark:text-slate-300">
        Calls to and from your numbers appear here for 90 days. You have no calls yet.
      </p>
    </div>
  );
}
