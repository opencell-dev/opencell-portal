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
