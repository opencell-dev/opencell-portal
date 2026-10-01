// One build, two sites (NOC design §N1.5). OC_SITE=portal is the public
// subscriber portal (opencell.k4ozi.com); OC_SITE=noc is the operators' site
// (noc.opencell.k4ozi.com), on its own guest with its own accounts. What each
// serves is decided here, for the proxy (src/proxy.ts), which runs before
// every page, prerendered or not. It is not the only check: requireNoc(), the
// NOC and role actions, sign-up and sign-in each check the site themselves,
// since Next runs a server action whatever page it is posted to.
// No imports: the proxy loads this.

export type Site = 'portal' | 'noc';

/** Where the proxy rewrites what a site does not serve: no route has it, so Next renders the 404 page. */
export const SITE_NOT_FOUND = '/_oc/not-found';

/** Only the NOC's site serves these. */
const NOC_ONLY = ['/noc'];

/** Only the subscriber portal serves these: sign-up and its CAPTCHA, the subscriber pages, the public pages. */
const PORTAL_ONLY = [
  '/sign-up',
  '/welcome',
  '/numbers',
  '/calls',
  '/directory',
  '/nodes',
  '/coverage',
  '/operator-agreement',
  '/api/altcha',
  '/altcha',
];

export type SiteRoute = { kind: 'serve' } | { kind: 'not-found' } | { kind: 'redirect'; to: string };

/**
 * The path as a router might read it: percent-decoded when it decodes,
 * lower case, with repeated slashes collapsed. Only ever used to refuse, so
 * reading it more loosely than Next does can only refuse more.
 */
function loose(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    // Not valid percent-encoding: match it as sent.
  }
  return p.toLowerCase().replace(/\/{2,}/g, '/');
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** What `site` does with a request for `pathname`. */
export function siteRoute(site: Site, method: string, pathname: string): SiteRoute {
  const p = loose(pathname);
  const elsewhere = site === 'portal' ? NOC_ONLY : PORTAL_ONLY;
  if (elsewhere.some((prefix) => under(p, prefix))) return { kind: 'not-found' };
  if (site === 'noc' && p === '/' && (method === 'GET' || method === 'HEAD')) return { kind: 'redirect', to: '/noc' };
  return { kind: 'serve' };
}

/** Where a signed-in person starts: a subscriber's numbers, or the NOC. */
export function siteHome(site: Site): string {
  return site === 'noc' ? '/noc' : '/numbers';
}
