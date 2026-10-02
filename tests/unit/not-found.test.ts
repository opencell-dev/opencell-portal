import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import NotFound from '@/app/not-found';

// M3 (final review): the global constraint "on the NOC's site, every link
// has prefetch={false}" (its Anubis policy has no public page, so every
// link there is behind the proof of work) applies to this page too, since
// it is also what src/lib/site.ts rewrites every 404 to, on either site.

function links(node: ReactNode, out: ReactElement<{ href: string; prefetch?: boolean }>[] = []) {
  if (Array.isArray(node)) for (const n of node) links(n, out);
  else if (node && typeof node === 'object' && 'props' in node) {
    const el = node as ReactElement<{ href: string; prefetch?: boolean; children?: ReactNode }>;
    if (el.type === Link) out.push(el);
    links(el.props.children, out);
  }
  return out;
}

describe('the not-found page', () => {
  it('does not prefetch its link home', () => {
    const all = links(NotFound());
    expect(all.length).toBeGreaterThan(0);
    for (const l of all) expect(l.props.prefetch, l.props.href).toBe(false);
  });
});
