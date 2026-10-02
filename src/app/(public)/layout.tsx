import { SiteHeader } from '@/components/site-header';
import { appCtx } from '@/lib/ctx';
import { currentSession } from '@/server/request';

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const s = await currentSession();
  return (
    <>
      <SiteHeader signedIn={Boolean(s)} site={appCtx().config.site} />
      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
    </>
  );
}
