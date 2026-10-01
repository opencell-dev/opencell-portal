import { notFound } from 'next/navigation';
import { DemoBanner } from '@/components/noc/demo-banner';
import { NocNav, nocLinks } from '@/components/noc/noc-nav';
import { appCtx } from '@/lib/ctx';
import { canUseAdmin } from '@/lib/sessions';
import { currentSession } from '@/server/request';

// Navigation only: each NOC page checks the session itself (requireNoc or
// requireAdmin), as every page does (src/server/request.ts). data-noc lets
// the (app) layout give the NOC the wider page (NOC design §9).
export default async function NocLayout({ children }: { children: React.ReactNode }) {
  const ctx = appCtx();
  // The NOC is on its own site (NOC design §N1.5); each page checks again (requireNoc).
  if (ctx.config.site !== 'noc') notFound();
  const s = await currentSession();
  const admin = s !== null && canUseAdmin(ctx, s.session);
  const fake = ctx.config.core === 'fake';
  return (
    <div data-noc className="space-y-4">
      <NocNav links={nocLinks(admin, fake)} />
      <DemoBanner fake={fake} />
      {children}
    </div>
  );
}
