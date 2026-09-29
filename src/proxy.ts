import { randomBytes } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { config as portalConfig } from '@/config';
import { buildCsp, originAllowed, securityHeaders } from '@/lib/web-security';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

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

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
