import { describe, expect, it } from 'vitest';

// The NOC's own site (NOC design §N1.5). config() reads process.env once, on
// the first proxy() call; Vitest runs each file in its own process (pool:
// 'forks'), so this file's OC_SITE never reaches proxy.test.ts.
process.env.OC_SITE = 'noc';
process.env.OC_ORIGIN = 'https://noc.portal.test';
process.env.OC_RP_ID = 'portal.test';
process.env.OC_SECRET = '0123456789abcdef0123456789abcdef';
process.env.OC_DB_PATH = ':memory:';

import { NextRequest } from 'next/server';
import { SITE_NOT_FOUND } from '@/lib/site';
import { proxy } from '@/proxy';

const ORIGIN = 'https://noc.portal.test';

function req(method: string, path: string) {
  const headers = new Headers(method === 'GET' || method === 'HEAD' ? {} : { origin: ORIGIN });
  return new NextRequest(new URL(path, ORIGIN), { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : 'x' });
}

const rewrittenTo = (res: Response) => res.headers.get('x-middleware-rewrite');

describe('proxy on the NOC site', () => {
  it.each(['/numbers', '/calls', '/directory', '/nodes', '/welcome', '/sign-up', '/coverage', '/operator-agreement', '/api/altcha'])(
    'shows the 404 page for the subscriber page %s',
    async (path) => {
      const res = await proxy(req('GET', path));
      expect(rewrittenTo(res)).toBe(`${ORIGIN}${SITE_NOT_FOUND}`);
      // The 404 page is still a page: it gets the nonce CSP and the security headers.
      expect(res.headers.get('content-security-policy')).toMatch(/nonce-/);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    },
  );

  it('sends the front page to the NOC', async () => {
    const res = await proxy(req('GET', '/'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/noc`);
  });

  it('serves the NOC, sign-in, the account and the admin pages', async () => {
    for (const path of ['/noc', '/noc/cells', '/sign-in', '/account', '/admin', '/admin/users', '/auth/email/x', '/healthz']) {
      const res = await proxy(req('GET', path));
      expect(rewrittenTo(res), path).toBeNull();
      expect(res.status, path).toBe(200);
    }
  });

  it('serves a server action posted to the front page (the action checks the site itself)', async () => {
    const res = await proxy(req('POST', '/'));
    expect(res.status).toBe(200);
    expect(rewrittenTo(res)).toBeNull();
  });
});
