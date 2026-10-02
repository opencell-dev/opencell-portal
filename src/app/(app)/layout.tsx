import { SiteHeader } from '@/components/site-header';
import { type Tab, Tabs } from '@/components/tabs';
import { appCtx } from '@/lib/ctx';
import { canUseAdmin, canUseNoc } from '@/lib/sessions';
import { requireUser } from '@/server/request';

const TABS: Tab[] = [
  { href: '/numbers', label: 'My numbers' },
  { href: '/calls', label: 'Calls' },
  { href: '/directory', label: 'Directory' },
  { href: '/nodes', label: 'Nodes' },
  { href: '/account', label: 'Account' },
];

// Navigation only: each page checks the session itself (src/server/request.ts).
// The subscriber portal has no NOC tab; the NOC's site (NOC design §N1.5) has
// only the NOC, the admin pages and Account.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session } = await requireUser();
  const ctx = appCtx();
  const site = ctx.config.site;
  const tabs: Tab[] =
    site === 'noc'
      ? [
          ...(canUseNoc(ctx, session) ? [{ href: '/noc', label: 'NOC' }] : []),
          ...(canUseAdmin(ctx, session) ? [{ href: '/admin', label: 'Admin' }] : []),
          { href: '/account', label: 'Account' },
        ]
      : [...TABS, ...(canUseAdmin(ctx, session) ? [{ href: '/admin', label: 'Admin' }] : [])];
  return (
    <>
      <SiteHeader signedIn site={site} />
      <Tabs tabs={tabs} />
      <main className="mx-auto max-w-5xl px-4 py-6 has-[[data-noc]]:max-w-7xl">{children}</main>
    </>
  );
}
