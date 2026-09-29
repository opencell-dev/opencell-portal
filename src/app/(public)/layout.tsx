import { SiteHeader } from '@/components/site-header';
import { currentSession } from '@/server/request';

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const s = await currentSession();
  return (
    <>
      <SiteHeader signedIn={Boolean(s)} />
      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
    </>
  );
}
