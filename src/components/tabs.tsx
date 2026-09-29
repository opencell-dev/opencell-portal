'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface Tab {
  href: string;
  label: string;
}

/** Layout A (spec §5): the signed-in pages as top tabs; scrolls sideways on a phone. */
export function Tabs({ tabs }: { tabs: Tab[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Sections" className="border-b border-slate-200 dark:border-slate-800">
      <ul className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4">
        {tabs.map((t) => {
          const active = path === t.href || path.startsWith(`${t.href}/`);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={`block whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                  active ? 'border-brand font-semibold text-brand' : 'border-transparent hover:border-slate-300'
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
