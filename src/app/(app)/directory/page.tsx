import type { Metadata } from 'next';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Directory' };

export default async function Directory() {
  const { user } = await requireUser();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Directory</h1>
      <p className="text-slate-600 dark:text-slate-300">
        The directory lists subscribers who chose to be listed, with their names and numbers. Only signed-in
        subscribers can see it. It fills as numbers are handed out.
      </p>
      <p className="text-sm text-slate-500">
        You are {user.directoryListed ? 'listed' : 'not listed'}. Change this on your Account page.
      </p>
    </div>
  );
}
