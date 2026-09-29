import { randomBytes } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { config as portalConfig } from '@/config';
import { buildCsp, originAllowed, securityHeaders } from '@/lib/web-security';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// Anchored so only the exact reserved paths are skipped: without the trailing
// `/` and `$`, a path like /favicon.icox or /_next/staticEvil would also
// match the old, unanchored alternation and bypass the CSP/origin check below.
export const PROXY_SKIP_SOURCE = '(?:_next/static|_next/image)/|favicon\\.ico$';
const PROXY_SKIP = new RegExp(`^(?:${PROXY_SKIP_SOURCE})`);

/** Whether the exported matcher would skip this path (kept in sync with it: same source string). */
export function proxySkipsPath(pathname: string): boolean {
  return PROXY_SKIP.test(pathname.replace(/^\//, ''));
}

export function proxy(req: NextRequest) {
  const c = portalConfig();
  const https = c.origin.startsWith('https:');
  if (!SAFE.has(req.method) && !originAllowed(req.headers.get('origin'), c.origin)) {
    return new NextResponse('Forbidden: this request did not come from the OpenCell portal.', { status: 403 });
  }
  const nonce = randomBytes(16).toString('base64');
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === 'development', https });
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  for (const [k, v] of securityHeaders(https)) res.headers.set(k, v);
  return res;
}

// Next statically parses this matcher at build time, so it must be a literal
// array of literal strings — it can't be built from PROXY_SKIP_SOURCE above.
// Keep the two in sync; proxy.test.ts checks the literal against the source.
export const config = {
  matcher: ['/((?!(?:_next/static|_next/image)/|favicon\\.ico$).*)'],
};
