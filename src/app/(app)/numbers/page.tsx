import type { Metadata } from 'next';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'My numbers' };

export default async function Numbers() {
  const { user } = await requireUser();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">My numbers</h1>
      <p className="text-slate-600 dark:text-slate-300">Hello {user.name}. You have no numbers yet.</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-dashed border-slate-300 p-6 dark:border-slate-700">
          <p className="text-lg font-medium">＋ Get a number</p>
          <p className="mt-1 text-sm text-slate-500">
            Numbers open soon. You will be able to hold up to {user.numberLimit}.
          </p>
        </div>
      </div>
    </div>
  );
}
