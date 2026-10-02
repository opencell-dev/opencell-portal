// Anubis in front of the NOC's own site (NOC design §N1.5), for real: the
// pinned Anubis release with the committed NOC policy and environment
// (deploy/anubis/oc-noc.*), proxying to the same production build run with
// OC_SITE=noc and the settings of deploy/noc.env.example. The test plays
// nginx-proxy, as anubis.test.ts does (which covers the rules the two sites
// share: dot segments, the email-link guard, client addresses). Run with
// `npm run test:anubis` (it builds first).
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANUBIS_DIR, anubisBinary, readEnvFile, REPO } from '../helpers/anubis';

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const PROD_DB = '/var/lib/anubis/oc-portal/anubis.bdb';

let dir: string;
let anubisPort: number;
let host: string;
let site: ChildProcess | undefined;
let anubis: ChildProcess | undefined;
let logs = '';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = gunzipSync(buf);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf.toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error(`timeout: GET ${path}`)));
    req.end();
  });
}

/** A browser behind nginx-proxy: a cookie jar and a client address. */
class Client {
  jar = new Map<string, string>();
  constructor(public ip: string) {}

  async get(path: string): Promise<Res> {
    const h: Record<string, string> = {
      host,
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-encoding': 'gzip',
      'x-forwarded-for': this.ip,
      'x-real-ip': this.ip,
      'x-forwarded-proto': 'http',
    };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await rawGet(anubisPort, path, h);
    for (const c of res.headers['set-cookie'] ?? []) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      const value = pair.slice(i + 1).trim();
      if (value) this.jar.set(pair.slice(0, i).trim(), value);
      else this.jar.delete(pair.slice(0, i).trim());
    }
    return res;
  }
}

type Challenge = { rules: { algorithm: string; difficulty: number }; challenge: { id: string; randomData: string } };

function challengeOf(res: Res): Challenge | null {
  const m = res.body.match(/<script id="anubis_challenge" type="application\/json">([^<]*)<\/script>/);
  return m ? (JSON.parse(m[1]) as Challenge) : null;
}

/** A page the site itself rendered: its proxy stamps a nonce CSP on every page. */
function fromSite(res: Res): boolean {
  return /nonce-/.test(String(res.headers['content-security-policy'] ?? '')) && challengeOf(res) === null;
}

/** Solve the proof of work the way Anubis's page script does; returns the client, now holding a pass. */
async function passProofOfWork(c: Client, path: string): Promise<Client> {
  const ch = challengeOf(await c.get(path));
  if (!ch || ch.rules.algorithm !== 'fast') throw new Error(`no proof-of-work challenge at ${path}`);
  const zeros = '0'.repeat(ch.rules.difficulty);
  let nonce = 0;
  let hash = '';
  for (;; nonce++) {
    hash = createHash('sha256').update(ch.challenge.randomData + nonce).digest('hex');
    if (hash.startsWith(zeros)) break;
  }
  const q = new URLSearchParams({ id: ch.challenge.id, response: hash, nonce: String(nonce), redir: `http://${host}${path}`, elapsedTime: '250' });
  const pass = await c.get(`/.within.website/x/cmd/anubis/api/pass-challenge?${q}`);
  if (pass.status !== 302) throw new Error(`pass-challenge answered ${pass.status}: ${pass.body.slice(0, 300)}`);
  return c;
}

async function waitFor(what: string, ok: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ok().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}\n${logs.slice(-4000)}`);
}

beforeAll(async () => {
  if (!existsSync(join(REPO, '.next', 'BUILD_ID'))) throw new Error('no production build: run `npm run build` first (npm run test:anubis does)');
  const bin = await anubisBinary();
  dir = mkdtempSync(join(tmpdir(), 'oc-anubis-noc-test-'));
  const sitePort = await freePort();
  anubisPort = await freePort();
  const metricsPort = await freePort();
  host = `localhost:${anubisPort}`;
  const collect = (tag: string) => (b: Buffer) => {
    logs += b.toString().replace(/^/gm, `[${tag}] `);
  };

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? dir,
    TMPDIR: dir,
    NODE_ENV: 'production',
    OC_SITE: 'noc',
    PORT: String(sitePort),
    OC_LISTEN: '127.0.0.1',
    OC_TRUSTED_PROXY: '127.0.0.1',
    OC_ORIGIN: `http://${host}`,
    OC_RP_ID: 'localhost',
    OC_SECRET: `anubis-noc-test-${randomBytes(12).toString('hex')}`,
    OC_DB_PATH: join(dir, 'portal.db'),
    OC_CORE: 'fake',
    OC_MAIL: 'outbox',
    OC_MAIL_OUTBOX: join(dir, 'outbox'),
  };
  const p = spawn(process.execPath, ['server.mjs'], { cwd: REPO, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', collect('noc'));
  p.stderr.on('data', collect('noc'));
  site = p;

  const policy = readFileSync(join(ANUBIS_DIR, 'oc-noc.botPolicies.yaml'), 'utf8');
  expect(policy).toContain(PROD_DB);
  writeFileSync(join(dir, 'policy.yaml'), policy.replace(PROD_DB, join(dir, 'anubis.bdb')));
  const anubisEnv: Record<string, string> = {
    ...readEnvFile(join(ANUBIS_DIR, 'oc-noc.env')),
    BIND: `127.0.0.1:${anubisPort}`,
    TARGET: `http://127.0.0.1:${sitePort}`,
    METRICS_BIND: `127.0.0.1:${metricsPort}`,
    POLICY_FNAME: join(dir, 'policy.yaml'),
    REDIRECT_DOMAINS: host,
    ED25519_PRIVATE_KEY_HEX: randomBytes(32).toString('hex'),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
  };
  const a = spawn(bin, [], { cwd: dir, env: anubisEnv as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  a.stdout.on('data', collect('anubis'));
  a.stderr.on('data', collect('anubis'));
  anubis = a;

  await waitFor('the NOC site', async () => (await rawGet(sitePort, '/healthz', {})).status === 200);
  await waitFor('anubis', async () => (await new Client('192.0.2.1').get('/healthz')).status === 200);
}, 180_000);

afterAll(() => {
  for (const p of [anubis, site]) if (p?.pid && p.exitCode === null) process.kill(p.pid, 'SIGTERM');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the NOC site's committed Anubis settings", () => {
  it("are the portal's but for the site's own name and pass-cookie prefix (M2, final review)", () => {
    const portal = readEnvFile(join(ANUBIS_DIR, 'oc-portal.env'));
    const noc = readEnvFile(join(ANUBIS_DIR, 'oc-noc.env'));
    expect(noc).toEqual({
      ...portal,
      COOKIE_DOMAIN: 'noc.opencell.k4ozi.com',
      REDIRECT_DOMAINS: 'noc.opencell.k4ozi.com',
      COOKIE_PREFIX: 'oc-noc-anubis',
    });
    expect(portal.COOKIE_PREFIX).not.toBe(noc.COOKIE_PREFIX);
  });

  it('have no public pages and no ALTCHA worker in the policy; the rest is the same', () => {
    const policy = readFileSync(join(ANUBIS_DIR, 'oc-noc.botPolicies.yaml'), 'utf8');
    expect(policy).not.toContain('public-pages');
    expect(policy).not.toMatch(/- path in \[/);
    expect(policy).not.toContain('altcha');
    for (const rule of ['health-check', 'next-static', 'site-files', 'email-links']) expect(policy).toContain(`- name: ${rule}`);
    // Every ALLOW rule keeps the dot-segment guard (anubis.test.ts says why).
    expect(policy.split(String.raw`'!path.matches("/\\.\\.?(/|$)")'`).length - 1).toBe(3);
  });
});

describe('unchallenged on the NOC site', () => {
  it('the health check, the static files, robots.txt', async () => {
    const c = new Client('203.0.113.7');
    expect((await c.get('/healthz')).status).toBe(200);
    const js = readdirSync(join(REPO, '.next', 'static', 'chunks')).find((f) => f.endsWith('.js'));
    expect((await c.get(`/_next/static/chunks/${js}`)).status).toBe(200);
    expect((await c.get('/robots.txt')).body).toMatch(/User-agent: \*/i);
  });
});

describe('challenged on the NOC site', () => {
  it.each(['/', '/coverage', '/operator-agreement', '/sign-in', '/sign-in?noc=1', '/account', '/noc', '/noc/cells', '/noc/calls', '/noc/calls/fake/1', '/noc/registrations', '/admin', '/admin/users', '/altcha/pbkdf2.js', '/api/altcha', '/wp-login.php'])(
    '%s gets the proof of work',
    async (path) => {
      expect(challengeOf(await new Client('203.0.113.7').get(path))?.rules).toEqual({ algorithm: 'fast', difficulty: 4 });
    },
  );

  it('/auth/email/… gets the no-JavaScript metarefresh challenge', async () => {
    expect(challengeOf(await new Client('203.0.113.7').get('/auth/email/not-a-token'))?.rules).toEqual({ algorithm: 'metarefresh', difficulty: 1 });
  });
});

describe('past the proof of work, the NOC site', () => {
  it('signs in staff: no sign-up, no subscriber page, and its front page is the NOC', async () => {
    const c = await passProofOfWork(new Client('203.0.113.20'), '/sign-in');
    const signIn = await c.get('/sign-in');
    expect(fromSite(signIn)).toBe(true);
    expect(signIn.body).toContain('Sign in to the OpenCell NOC');
    expect(signIn.body).not.toContain('href="/sign-up"');
    const front = await c.get('/');
    expect(front.status).toBe(307);
    expect(front.headers.location).toBe(`http://${host}/noc`);
    for (const path of ['/sign-up', '/numbers', '/coverage']) {
      const r = await c.get(path);
      expect(r.status, path).toBe(404);
      expect(fromSite(r), path).toBe(true);
    }
  });

  // M2 (final review): a distinct COOKIE_PREFIX, checked against a real
  // Anubis pass, not just the committed .env files.
  it("the pass cookie's name carries the NOC's own prefix, never the portal's", async () => {
    const c = await passProofOfWork(new Client('203.0.113.21'), '/sign-in');
    const names = [...c.jar.keys()];
    expect(names.some((k) => k.startsWith('oc-noc-anubis-auth-'))).toBe(true);
    expect(names.some((k) => k.startsWith('oc-anubis-auth-'))).toBe(false);
  });
});
