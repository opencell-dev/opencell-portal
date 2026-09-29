import { describe, expect, it } from 'vitest';

// config() is lazy and reads process.env on first call (inside proxy()), so
// setting these before any test runs is enough; import hoisting doesn't matter.
process.env.OC_ORIGIN = 'https://portal.test';
process.env.OC_RP_ID = 'portal.test';
process.env.OC_SECRET = '0123456789abcdef0123456789abcdef';
process.env.OC_DB_PATH = ':memory:';

import { NextRequest } from 'next/server';
import { config as proxyConfig, PROXY_SKIP_SOURCE, proxy, proxySkipsPath } from '@/proxy';

const ORIGIN = 'https://portal.test';

function req(method: string, origin?: string | null, extraHeaders: Record<string, string> = {}) {
  const headers = new Headers(extraHeaders);
  if (origin !== undefined && origin !== null) headers.set('origin', origin);
  return new NextRequest(new URL('/x', ORIGIN), { method, headers });
}

describe('proxy origin check (CSRF, spec §10)', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('403s a %s request with no Origin header', (method) => {
    expect(proxy(req(method)).status).toBe(403);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('403s a %s request with a foreign Origin', (method) => {
    expect(proxy(req(method, 'https://evil.example')).status).toBe(403);
  });

  it('403s a POST with Origin: null', () => {
    expect(proxy(req('POST', 'null')).status).toBe(403);
  });

  it('403s a server action (a POST carrying Next-Action) from a foreign origin', () => {
    expect(proxy(req('POST', 'https://evil.example', { 'Next-Action': 'abc123' })).status).toBe(403);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('passes a %s request that carries the portal’s own Origin', (method) => {
    expect(proxy(req(method, ORIGIN)).status).not.toBe(403);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('never checks Origin on a safe %s request', (method) => {
    expect(proxy(req(method, 'https://evil.example')).status).not.toBe(403);
  });
});

describe('proxy matcher (spec §10 — every response must be hardened, not just page loads)', () => {
  it('exempts only the exact reserved paths, not anything that merely starts with their name', () => {
    expect(proxySkipsPath('/favicon.ico')).toBe(true);
    expect(proxySkipsPath('/favicon.icox')).toBe(false);
    expect(proxySkipsPath('/_next/static/chunk.js')).toBe(true);
    expect(proxySkipsPath('/_next/staticwhatever')).toBe(false);
    expect(proxySkipsPath('/_next/image/foo')).toBe(true);
    expect(proxySkipsPath('/_next/imagewhatever')).toBe(false);
  });

  it('keeps the exported (necessarily literal) Next.js matcher in sync with the source proxySkipsPath uses', () => {
    // Next statically parses `config.matcher` at build time, so it has to be
    // a literal string and can't be built from PROXY_SKIP_SOURCE at runtime.
    // This is the guard against the two drifting apart.
    expect(proxyConfig.matcher).toEqual([`/((?!${PROXY_SKIP_SOURCE}).*)`]);
  });
});
