import Link from 'next/link';

export interface NocLink {
  href: string;
  label: string;
}

/**
 * The NOC's sections (NOC design §9). Number lookup is open to any staff
 * viewer, admin or NOC operator (ruling 2026-10-01 #8/#9, overriding portal
 * spec §10); the demo controls stay admin-only.
 */
export function nocLinks(admin: boolean, fake: boolean): NocLink[] {
  return [
    { href: '/noc', label: 'Overview' },
    { href: '/noc/cells', label: 'Cells' },
    { href: '/noc/topology', label: 'Topology' },
    { href: '/noc/lookup', label: 'Number lookup' },
    ...(admin && fake ? [{ href: '/noc/demo', label: 'Demo controls' }] : []),
  ];
}

// prefetch={false}: these pages are behind Anubis (see site-header.tsx).
export function NocNav({ links }: { links: NocLink[] }) {
  return (
    <nav aria-label="NOC" className="flex flex-wrap gap-x-4 gap-y-1 border-b border-slate-200 pb-2 text-sm dark:border-slate-800">
      {links.map((l) => (
        <Link key={l.href} href={l.href} prefetch={false} className="hover:underline">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
