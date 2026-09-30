import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { SiteHeader } from '@/components/site-header';

// Anubis (deploy/anubis) gives each challenge rule its own pass: the pass for
// the email-link rule is cleared by any request under the proof-of-work rule.
// A background prefetch from the email-link page (whose header this is) to
// /sign-in or /numbers would clear it before the person presses Confirm, and
// the confirm POST would get a challenge page instead of the portal. So the
// header prefetches only the pages Anubis lets through unchallenged.
const policy = readFileSync(join(import.meta.dirname, '..', '..', 'deploy', 'anubis', 'oc-portal.botPolicies.yaml'), 'utf8');
const publicList = policy.match(/- path in \[([^\]]*)\]/)?.[1];
const PUBLIC = new Set((publicList ?? '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')));

function links(node: ReactNode, out: ReactElement<{ href: string; prefetch?: boolean }>[] = []) {
  if (Array.isArray(node)) for (const n of node) links(n, out);
  else if (node && typeof node === 'object' && 'props' in node) {
    const el = node as ReactElement<{ href: string; prefetch?: boolean; children?: ReactNode }>;
    if (el.type === Link) out.push(el);
    links(el.props.children, out);
  }
  return out;
}

describe('SiteHeader and Anubis', () => {
  it('reads the public pages from the Anubis policy', () => {
    expect([...PUBLIC].sort()).toEqual(['/', '/coverage', '/operator-agreement']);
  });

  it.each([false, true])('does not prefetch a challenged page (signed in: %s)', (signedIn) => {
    const all = links(SiteHeader({ signedIn }));
    expect(all.length).toBeGreaterThan(3);
    for (const l of all) {
      if (PUBLIC.has(l.props.href)) expect(l.props.prefetch, l.props.href).not.toBe(false);
      else expect(l.props.prefetch, l.props.href).toBe(false);
    }
  });
});
