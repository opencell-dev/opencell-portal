import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// config() is lazy and reads process.env on first call (inside proxy()), so
// setting these before any test runs is enough; import hoisting doesn't matter.
process.env.OC_ORIGIN = 'https://portal.test';
process.env.OC_RP_ID = 'portal.test';
process.env.OC_SECRET = '0123456789abcdef0123456789abcdef';
process.env.OC_DB_PATH = ':memory:';

import { NextRequest } from 'next/server';
import { config as proxyConfig, PROXY_SKIP_SOURCE, proxy, proxySkipsPath } from '@/proxy';
import { CONFIRM, MAGIC, MANIFEST } from '../helpers/action-manifest';

const ORIGIN = 'https://portal.test';

function req(method: string, origin?: string | null, extraHeaders: Record<string, string> = {}, path = '/x') {
  const headers = new Headers(extraHeaders);
  if (origin !== undefined && origin !== null) headers.set('origin', origin);
  return new NextRequest(new URL(path, ORIGIN), { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : 'x' });
}

describe('proxy origin check (CSRF, spec §10)', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('403s a %s request with no Origin header', async (method) => {
    expect((await proxy(req(method))).status).toBe(403);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('403s a %s request with a foreign Origin', async (method) => {
    expect((await proxy(req(method, 'https://evil.example'))).status).toBe(403);
  });

  it('403s a POST with Origin: null', async () => {
    expect((await proxy(req('POST', 'null'))).status).toBe(403);
  });

  it('403s a server action (a POST carrying Next-Action) from a foreign origin', async () => {
    expect((await proxy(req('POST', 'https://evil.example', { 'Next-Action': 'abc123' }))).status).toBe(403);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('passes a %s request that carries the portal’s own Origin', async (method) => {
    expect((await proxy(req(method, ORIGIN))).status).not.toBe(403);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('never checks Origin on a safe %s request', async (method) => {
    expect((await proxy(req(method, 'https://evil.example'))).status).not.toBe(403);
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

describe('proxy: the emailed-link page takes only its Confirm action (Anubis gives it the light challenge)', () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'oc-proxy-'));
  const emailReq = (method: string, headers: Record<string, string> = {}) => req(method, ORIGIN, headers, '/auth/email/tok');
  beforeAll(() => {
    mkdirSync(join(dir, 'with', '.next', 'server'), { recursive: true });
    writeFileSync(join(dir, 'with', '.next', 'server', 'server-reference-manifest.json'), JSON.stringify(MANIFEST));
    mkdirSync(join(dir, 'without'));
  });
  afterAll(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes the Confirm action', async () => {
    process.chdir(join(dir, 'with'));
    expect((await proxy(emailReq('POST', { 'next-action': CONFIRM }))).status).not.toBe(403);
  });

  it('403s any other server action posted there', async () => {
    process.chdir(join(dir, 'with'));
    expect((await proxy(emailReq('POST', { 'next-action': MAGIC }))).status).toBe(403);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('403s a %s that is not the Confirm action', async (method) => {
    process.chdir(join(dir, 'with'));
    expect((await proxy(emailReq(method))).status).toBe(403);
  });

  it('still serves the page (GET) and other paths as before', async () => {
    process.chdir(join(dir, 'with'));
    expect((await proxy(emailReq('GET'))).status).not.toBe(403);
    expect((await proxy(req('POST', ORIGIN, { 'next-action': MAGIC }, '/sign-in'))).status).not.toBe(403);
  });

  it('fails closed without a build manifest', async () => {
    process.chdir(join(dir, 'without'));
    expect((await proxy(emailReq('POST', { 'next-action': CONFIRM }))).status).toBe(403);
  });
});

describe('proxy on the subscriber portal: no NOC (NOC design §N1.5)', () => {
  // The rewrite target is always http (production bug, 2026-10-02 below),
  // even though ORIGIN (and OC_ORIGIN in production) is https.
  const HTTP_NOT_FOUND = 'http://portal.test/_oc/not-found';

  it.each(['/noc', '/noc/', '/noc/cells', '/noc/cores/core1', '/noc/lookup', '/noc/demo', '/NOC'])('shows the 404 page for %s', async (path) => {
    const res = await proxy(req('GET', undefined, {}, path));
    expect(res.headers.get('x-middleware-rewrite')).toBe(HTTP_NOT_FOUND);
    expect(res.headers.get('content-security-policy')).toMatch(/nonce-/);
  });

  it('a POST to the NOC is not served either', async () => {
    const res = await proxy(req('POST', ORIGIN, { 'next-action': 'abc' }, '/noc/lookup'));
    expect(res.headers.get('x-middleware-rewrite')).toBe(HTTP_NOT_FOUND);
  });

  it('serves the subscriber pages and the front page as before', async () => {
    for (const path of ['/', '/numbers', '/sign-up', '/admin', '/coverage']) {
      const res = await proxy(req('GET', undefined, {}, path));
      expect(res.headers.get('x-middleware-rewrite'), path).toBeNull();
      expect(res.status, path).toBe(200);
    }
  });
});

// Production bug (2026-10-02): nginx-proxy/Anubis always forward
// X-Forwarded-Proto: https (TLS is terminated upstream), which Next folds
// into its own idea of this request's origin. The 404 rewrite used to
// reuse that origin for a same-process fetch, so the real server (plain
// HTTP; server.mjs) was asked to speak TLS to itself and failed ("wrong
// version number"), turning every 404 on the live sites into a 500.
describe('proxy: the 404 rewrite always targets this server’s own http origin', () => {
  it('rewrites to http, never to OC_ORIGIN’s https, for an ordinary request', async () => {
    const res = await proxy(req('GET', undefined, {}, '/noc'));
    expect(res.headers.get('x-middleware-rewrite')).toBe('http://portal.test/_oc/not-found');
  });

  it('still rewrites to http when the request carries X-Forwarded-Proto: https (the trusted proxy’s header)', async () => {
    const res = await proxy(req('GET', undefined, { 'x-forwarded-proto': 'https' }, '/noc'));
    expect(res.headers.get('x-middleware-rewrite')).toBe('http://portal.test/_oc/not-found');
  });
});
