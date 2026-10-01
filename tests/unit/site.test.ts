import { describe, expect, it } from 'vitest';
import { SITE_NOT_FOUND, siteHome, siteRoute } from '@/lib/site';

// NOC design §N1.5: one build, two sites. The public portal never serves the
// NOC; the NOC's own site serves sign-in, accounts, the NOC and the admin
// pages, and none of the subscriber pages.
const kind = (site: 'portal' | 'noc', path: string, method = 'GET') => siteRoute(site, method, path).kind;

describe('what each site serves', () => {
  it.each(['/noc', '/noc/', '/noc/cells', '/noc/cells/core1/3', '/noc/lookup', '/noc/demo', '/NOC', '/Noc/Cells', '/%6eoc', '/%6Eoc/cells', '//noc', '/noc//cells'])(
    'the portal does not serve %s',
    (path) => {
      expect(kind('portal', path)).toBe('not-found');
      expect(kind('portal', path, 'POST')).toBe('not-found');
    },
  );

  it.each(['/', '/sign-in', '/sign-up', '/welcome', '/numbers', '/calls', '/directory', '/nodes', '/account', '/admin', '/admin/users', '/coverage', '/operator-agreement', '/auth/email/x', '/api/altcha', '/healthz', '/nocturne', '/nocx/y'])(
    'the portal serves %s',
    (path) => {
      expect(kind('portal', path)).toBe('serve');
    },
  );

  it.each(['/sign-up', '/welcome', '/numbers', '/numbers/x', '/calls', '/directory', '/nodes', '/coverage', '/operator-agreement', '/api/altcha', '/altcha/altcha.js', '/NUMBERS', '/%6eumbers', '//sign-up'])(
    'the NOC site does not serve %s',
    (path) => {
      expect(kind('noc', path)).toBe('not-found');
      expect(kind('noc', path, 'POST')).toBe('not-found');
    },
  );

  it.each(['/sign-in', '/sign-in?noc=1', '/account', '/admin', '/admin/users', '/auth/email/x', '/noc', '/noc/cells', '/noc/demo', '/healthz', '/numbersx'])(
    'the NOC site serves %s',
    (path) => {
      expect(kind('noc', path.split('?')[0])).toBe('serve');
    },
  );

  it("sends the NOC site's front page to the NOC, for a GET or HEAD only", () => {
    expect(siteRoute('noc', 'GET', '/')).toEqual({ kind: 'redirect', to: '/noc' });
    expect(siteRoute('noc', 'HEAD', '/')).toEqual({ kind: 'redirect', to: '/noc' });
    // A server action may be posted to any page: it is served, and the action checks the site itself.
    expect(siteRoute('noc', 'POST', '/')).toEqual({ kind: 'serve' });
  });

  it('never throws on a path that does not decode', () => {
    expect(kind('portal', '/%E0%A4%A')).toBe('serve');
    expect(kind('noc', '/%E0%A4%A')).toBe('serve');
    expect(kind('portal', '/noc/%E0%A4%A')).toBe('not-found');
  });

  it('rewrites what a site does not serve to a path no route has (the 404 page)', () => {
    expect(SITE_NOT_FOUND).toBe('/_oc/not-found');
    expect(kind('portal', SITE_NOT_FOUND)).toBe('serve');
  });

  it("has a home page per site: the subscriber's numbers, the operator's NOC", () => {
    expect(siteHome('portal')).toBe('/numbers');
    expect(siteHome('noc')).toBe('/noc');
  });
});
