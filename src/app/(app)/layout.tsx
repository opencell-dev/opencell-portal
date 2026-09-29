import { SiteHeader } from '@/components/site-header';
import { type Tab, Tabs } from '@/components/tabs';
import { appCtx } from '@/lib/ctx';
import { canUseAdmin } from '@/lib/sessions';
import { requireUser } from '@/server/request';

const TABS: Tab[] = [
  { href: '/numbers', label: 'My numbers' },
  { href: '/calls', label: 'Calls' },
  { href: '/directory', label: 'Directory' },
  { href: '/nodes', label: 'Nodes' },
  { href: '/account', label: 'Account' },
];

// Navigation only: each page checks the session itself (src/server/request.ts).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session } = await requireUser();
  const tabs = canUseAdmin(appCtx(), session) ? [...TABS, { href: '/admin', label: 'Admin' }] : TABS;
  return (
    <>
      <SiteHeader signedIn />
      <Tabs tabs={tabs} />
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </>
  );
}
