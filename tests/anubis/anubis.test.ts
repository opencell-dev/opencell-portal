// Anubis in front of the portal, for real: the pinned Anubis release with
// the committed policy and environment (deploy/anubis/), proxying to a
// production build of the portal started with the settings of
// deploy/portal.env.example (127.0.0.1, OC_TRUSTED_PROXY=127.0.0.1). The
// test plays nginx-proxy: every request carries X-Forwarded-For and
// X-Real-IP set to the "client" address, as NPM's proxy.conf sets them from
// $remote_addr. Run with `npm run test:anubis` (it builds first).
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '@/config';
import { FakeCore } from '@/core/fake';
import { openDb } from '@/db';
import { audit, rateEvents, sessions } from '@/db/schema';
import { signUp } from '@/lib/accounts';
import type { Ctx } from '@/lib/ctx';
import { MemoryMailer } from '@/lib/mail';
import { createMailQueue } from '@/lib/mailqueue';
import { rateKey } from '@/lib/ratelimit';
import { ANUBIS_DIR, anubisBinary, readEnvFile, REPO } from '../helpers/anubis';
import { solvedCaptcha } from '../helpers/captcha';

const SECRET = `anubis-test-${randomBytes(12).toString('hex')}`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const PROD_DB = '/var/lib/anubis/oc-portal/anubis.bdb';

let dir: string;
let anubisPort: number;
let host: string;
let portal: ChildProcess | undefined;
let anubis: ChildProcess | undefined;
let logs = '';
let ctx: Ctx;

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

function rawRequest(port: number, method: string, path: string, headers: Record<string, string>, body?: Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
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
    req.setTimeout(20_000, () => req.destroy(new Error(`timeout: ${method} ${path}`)));
    if (body) req.write(body);
    req.end();
  });
}

/** A browser behind nginx-proxy: its own cookie jar and client address. */
class Client {
  jar = new Map<string, string>();
  constructor(
    public ip: string,
    public extra: Record<string, string> = {},
  ) {}

  headers(more: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      host,
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-encoding': 'gzip',
      'x-forwarded-for': this.ip,
      'x-real-ip': this.ip,
      'x-forwarded-proto': 'http',
      ...this.extra,
      ...more,
    };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    return h;
  }

  keep(res: Res): Res {
    const set = res.headers['set-cookie'] ?? [];
    for (const c of set) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const gone = !value || attrs.some((a) => /^\s*max-age=(0|-\d+)\s*$/i.test(a));
      if (gone) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  async get(path: string, more: Record<string, string> = {}): Promise<Res> {
    return this.keep(await rawRequest(anubisPort, 'GET', path, this.headers(more)));
  }

  async post(path: string, form: FormData, more: Record<string, string> = {}): Promise<Res> {
    const r = new Request('http://x/', { method: 'POST', body: form });
    const body = Buffer.from(await r.arrayBuffer());
    const h = this.headers({ origin: `http://${host}`, 'content-type': r.headers.get('content-type') ?? '', ...more });
    h['content-length'] = String(body.length);
    return this.keep(await rawRequest(anubisPort, 'POST', path, h, body));
  }

  anubisCookie(): string | undefined {
    return [...this.jar.keys()].find((k) => k.startsWith('oc-anubis-auth-'));
  }
}

type Challenge = { rules: { algorithm: string; difficulty: number }; challenge: { id: string; randomData: string } };

function challengeOf(res: Res): Challenge | null {
  const m = res.body.match(/<script id="anubis_challenge" type="application\/json">([^<]*)<\/script>/);
  return m ? (JSON.parse(m[1]) as Challenge) : null;
}

/** A page the portal itself rendered: its proxy stamps a nonce CSP on every page. */
function fromPortal(res: Res): boolean {
  return /nonce-/.test(String(res.headers['content-security-policy'] ?? '')) && challengeOf(res) === null;
}

function decode(s: string): string {
  return s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

/** Solve the proof of work the way Anubis's page script does, then follow its redirect back. */
async function passProofOfWork(c: Client, path: string): Promise<Res> {
  const page = await c.get(path);
  const ch = challengeOf(page);
  if (!ch || ch.rules.algorithm !== 'fast') throw new Error(`no proof-of-work challenge at ${path}: ${page.status} ${page.body.slice(0, 200)}`);
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
  expect(pass.headers.location).toBe(`http://${host}${path}`);
  return c.get(path);
}

/** Wait out the no-JS challenge and follow its refresh, as a browser without JavaScript does. */
async function passMetaRefresh(c: Client, path: string): Promise<Res> {
  const page = await c.get(path);
  const ch = challengeOf(page);
  if (!ch || ch.rules.algorithm !== 'metarefresh') throw new Error(`no metarefresh challenge at ${path}: ${page.status}`);
  const meta = page.body.match(/<meta http-equiv="refresh" content="(\d+); url=([^"]+)"/);
  const header = String(page.headers.refresh ?? '').match(/^(\d+); url=(.+)$/);
  const [, secs, url] = meta ?? header ?? [];
  if (!url) throw new Error('metarefresh page without a refresh');
  await new Promise((r) => setTimeout(r, Number(secs) * 1000));
  const pass = await c.get(decode(url));
  if (pass.status !== 302) throw new Error(`metarefresh pass answered ${pass.status}: ${pass.body.slice(0, 300)}`);
  const loc = String(pass.headers.location);
  return c.get(loc.startsWith('http') ? new URL(loc).pathname : loc);
}

/** The fields of the (no-JS) form that contains `marker`, as a browser without JavaScript would submit them. */
function formWith(html: string, marker: string): FormData {
  const form = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].find((m) => m[1].includes(marker));
  if (!form) throw new Error(`no form with ${marker}`);
  const fd = new FormData();
  for (const [input] of form[1].matchAll(/<input\b[^>]*>/g)) {
    const name = input.match(/\bname="([^"]*)"/)?.[1];
    if (!name) continue;
    fd.append(decode(name), decode(input.match(/\bvalue="([^"]*)"/)?.[1] ?? ''));
  }
  return fd;
}

function rateCount(name: 'magic_ip', ip: string): number {
  return ctx.db.select().from(rateEvents).where(eq(rateEvents.key, rateKey(ctx, name, ip))).all().length;
}

async function requestSignInLink(c: Client, email: string): Promise<Res> {
  const page = await c.get('/sign-in');
  expect(fromPortal(page)).toBe(true);
  const fd = formWith(page.body, 'name="email"');
  fd.set('email', email);
  return c.post('/sign-in', fd);
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
  dir = mkdtempSync(join(tmpdir(), 'oc-anubis-test-'));
  const portalPort = await freePort();
  anubisPort = await freePort();
  const metricsPort = await freePort();
  host = `localhost:${anubisPort}`;

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? dir,
    TMPDIR: dir,
    NODE_ENV: 'production',
    PORT: String(portalPort),
    OC_LISTEN: '127.0.0.1',
    OC_TRUSTED_PROXY: '127.0.0.1',
    OC_ORIGIN: `http://${host}`,
    OC_RP_ID: 'localhost',
    OC_SECRET: SECRET,
    OC_DB_PATH: join(dir, 'portal.db'),
    OC_CORE: 'fake',
    OC_MAIL: 'outbox',
    OC_MAIL_OUTBOX: join(dir, 'outbox'),
    OC_ALTCHA_COST: '10',
    OC_ALTCHA_COUNTER_MAX: '50',
  };
  const collect = (tag: string) => (b: Buffer) => {
    logs += b.toString().replace(/^/gm, `[${tag}] `);
  };
  const p = spawn(process.execPath, ['server.mjs'], { cwd: REPO, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', collect('portal'));
  p.stderr.on('data', collect('portal'));
  portal = p;

  // The committed policy, verbatim but for where bbolt keeps its file.
  const policy = readFileSync(join(ANUBIS_DIR, 'oc-portal.botPolicies.yaml'), 'utf8');
  expect(policy).toContain(PROD_DB);
  writeFileSync(join(dir, 'policy.yaml'), policy.replace(PROD_DB, join(dir, 'anubis.bdb')));
  // The committed environment, but for the loopback test ports and the test
  // host: what differs on the guest is only where things listen.
  const anubisEnv: Record<string, string> = {
    ...readEnvFile(join(ANUBIS_DIR, 'oc-portal.env')),
    BIND: `127.0.0.1:${anubisPort}`,
    TARGET: `http://127.0.0.1:${portalPort}`,
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

  await waitFor('the portal', async () => (await rawRequest(portalPort, 'GET', '/healthz', {})).status === 200);
  await waitFor('anubis', async () => (await new Client('192.0.2.1').get('/healthz')).status === 200);

  const mailer = new MemoryMailer();
  const core = new FakeCore(() => Date.now());
  ctx = {
    config: parseConfig(env),
    db: openDb(env.OC_DB_PATH),
    mailer,
    mailQueue: createMailQueue(mailer),
    core,
    cores: [{ id: 'fake', where: 'in-process', core }],
    now: () => Date.now(),
  } as Ctx;
}, 180_000);

afterAll(() => {
  // By PID, only the two processes this test started.
  for (const p of [anubis, portal]) if (p?.pid && p.exitCode === null) process.kill(p.pid, 'SIGTERM');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the committed Anubis settings', () => {
  it('forward to the portal on 127.0.0.1:3001 and keep the portal behind them', () => {
    const e = readEnvFile(join(ANUBIS_DIR, 'oc-portal.env'));
    expect(e.BIND).toBe(':3000');
    // An IPv4 literal: "localhost" could connect from ::1, which is not
    // OC_TRUSTED_PROXY, and the portal would drop X-Forwarded-For.
    expect(e.TARGET).toBe('http://127.0.0.1:3001');
    expect(e.METRICS_BIND).toBe('127.0.0.1:9090');
    const p = readEnvFile(join(REPO, 'deploy', 'portal.env.example'));
    expect([p.PORT, p.OC_LISTEN, p.OC_TRUSTED_PROXY]).toEqual(['3001', '127.0.0.1', '127.0.0.1']);
  });

  it('set the cookie and client-address options this deployment relies on', () => {
    const e = readEnvFile(join(ANUBIS_DIR, 'oc-portal.env'));
    expect(e).toMatchObject({
      SERVE_ROBOTS_TXT: 'true',
      COOKIE_DOMAIN: 'opencell.k4ozi.com',
      COOKIE_SECURE: 'true',
      COOKIE_SAME_SITE: 'Lax',
      COOKIE_PARTITIONED: 'false',
      COOKIE_HTTP_ONLY: 'true',
      COOKIE_PREFIX: 'oc-anubis',
      REDIRECT_DOMAINS: 'opencell.k4ozi.com',
      JWT_RESTRICTION_HEADER: 'X-Real-IP',
      XFF_STRIP_PRIVATE: 'true',
    });
    expect(e.ED25519_PRIVATE_KEY_HEX).toBeUndefined(); // generated on the guest, never in git
  });
});

describe('unchallenged: health check, public pages, static files', () => {
  it('lets /healthz through without a browser user agent or cookie', async () => {
    const r = await new Client('203.0.113.7', { 'user-agent': 'curl/8.14.1' }).get('/healthz');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true });
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it.each(['/', '/coverage', '/operator-agreement'])('lets GET %s through', async (path) => {
    const c = new Client('203.0.113.7');
    const r = await c.get(path);
    expect(r.status).toBe(200);
    expect(fromPortal(r)).toBe(true);
    expect(c.anubisCookie()).toBeUndefined();
  });

  it("lets Next's static build files through", async () => {
    const chunks = join(REPO, '.next', 'static', 'chunks');
    const js = readdirSync(chunks).find((f) => f.endsWith('.js'));
    const r = await new Client('203.0.113.7').get(`/_next/static/chunks/${js}`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/javascript/);
  });

  it('lets /.well-known/ through (the portal answers: it has none yet, a 404)', async () => {
    const r = await new Client('203.0.113.7').get('/.well-known/security.txt');
    expect(challengeOf(r)).toBeNull();
    expect(r.status).toBe(404);
  });

  it('lets the ALTCHA worker and favicon path through', async () => {
    expect((await new Client('203.0.113.7').get('/altcha/pbkdf2.js')).status).toBe(200);
    const fav = await new Client('203.0.113.7').get('/favicon.ico');
    expect(challengeOf(fav)).toBeNull(); // the portal's own answer (it has none yet: a 404)
  });

  it('serves robots.txt itself', async () => {
    const r = await new Client('203.0.113.7').get('/robots.txt');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/User-agent: \*/i);
  });
});

describe('challenged', () => {
  it.each([
    '/sign-in',
    '/sign-in?admin=1',
    '/sign-up',
    '/welcome',
    '/numbers',
    '/calls',
    '/directory',
    '/nodes',
    '/account',
    '/admin',
    '/admin/users',
    '/api/altcha',
    '/wp-login.php',
    '/_next/image?url=%2Fx&w=64&q=75',
  ])('%s gets the proof-of-work challenge', async (path) => {
    const r = await new Client('203.0.113.7').get(path);
    expect(challengeOf(r)?.rules).toEqual({ algorithm: 'fast', difficulty: 4 });
  });

  // Dot segments: Anubis matches the decoded path as sent, while Next (like
  // nginx-proxy's proxy_pass ...$request_uri, which passes it on raw)
  // resolves them. Sent as-is: the test client never normalizes a path.
  it.each([
    '/_next/static/../../sign-in',
    '/_next/static/%2e%2e/%2e%2e/sign-in',
    '/_next/static/.%2E/.%2E/sign-in',
    '/_next/static/../../numbers',
    '/_next/static/../../api/altcha',
    '/_next/static/./../../sign-in',
    '/.well-known/../sign-in',
    '/.well-known/%2e%2e/api/altcha',
    '/.well-known/./../sign-up',
    '/altcha/../sign-in',
    '/altcha/%2e%2e/api/altcha',
    '/healthz/../sign-in',
    '/coverage/../sign-in',
    '/./sign-in',
    '/favicon.ico/../sign-in',
  ])('%s (dot segments out of an open prefix) gets the proof-of-work challenge', async (path) => {
    const r = await new Client('203.0.113.7').get(path);
    expect(challengeOf(r)?.rules.algorithm).toBe('fast');
  });

  it('a POST to a public page is challenged too (a server action can be sent to any page)', async () => {
    const r = await new Client('203.0.113.7').post('/', new FormData());
    expect(challengeOf(r)?.rules.algorithm).toBe('fast');
  });

  it('/auth/email/… gets the no-JavaScript metarefresh challenge', async () => {
    const r = await new Client('203.0.113.7').get('/auth/email/not-a-token');
    expect(challengeOf(r)?.rules).toEqual({ algorithm: 'metarefresh', difficulty: 1 });
  });

  it('a server-action POST without a pass never reaches the portal', async () => {
    const ip = '203.0.113.50';
    const c = new Client(ip);
    const before = rateCount('magic_ip', ip);
    const fd = new FormData();
    fd.set('email', 'nobody@example.org');
    const r = await c.post('/sign-in', fd, { 'next-action': 'x' });
    expect(challengeOf(r)).not.toBeNull();
    expect(rateCount('magic_ip', ip)).toBe(before);
  });
});

describe('passing', () => {
  it('a client that solves the proof of work reaches /sign-in; the pass is bound to its address', async () => {
    const c = new Client('203.0.113.7');
    const page = await passProofOfWork(c, '/sign-in');
    expect(page.status).toBe(200);
    expect(fromPortal(page)).toBe(true);
    expect(page.body).toContain('Email me a sign-in link');
    // The same pass covers every page under that rule, sign-up and the signed-in pages alike.
    expect(fromPortal(await c.get('/sign-up'))).toBe(true);
    // From another address it is no pass (JWT_RESTRICTION_HEADER=X-Real-IP).
    c.ip = '203.0.113.8';
    expect(challengeOf(await c.get('/sign-in'))).not.toBeNull();
  });

  it('a pass from one rule is not a pass for the other (why the header links to challenged pages do not prefetch)', async () => {
    const c = new Client('203.0.113.9');
    await passProofOfWork(c, '/sign-in');
    const r = await c.get('/auth/email/not-a-token');
    expect(challengeOf(r)?.rules.algorithm).toBe('metarefresh');
    expect(c.anubisCookie()).toBeUndefined(); // cleared: the proof-of-work pass is gone too
  });

  it('an email link works without JavaScript: wait, page, confirm, signed in — the portal records the real address', async () => {
    const email = `ada-${randomBytes(4).toString('hex')}@example.org`;
    const signup = await signUp(ctx, { name: 'Ada', email, altcha: await solvedCaptcha(ctx) }, { ip: '192.0.2.99' });
    expect(signup).toEqual({ ok: true });
    const link = new URL((ctx.mailer as MemoryMailer).lastLink(email));
    expect(link.origin).toBe(`http://${host}`);

    const c = new Client('198.51.100.23');
    const page = await passMetaRefresh(c, link.pathname);
    expect(fromPortal(page)).toBe(true);
    expect(page.body).toContain('Confirm my email');

    const done = await c.post(link.pathname, formWith(page.body, '$ACTION'));
    expect(done.status).toBe(303);
    expect(done.headers.location).toBe('/welcome');
    const token = [...c.jar].find(([k]) => !k.startsWith('oc-anubis'))?.[1];
    expect(token).toBeTruthy();
    const verify = ctx.db.select().from(audit).where(eq(audit.action, 'account.verify')).all().at(-1);
    expect(verify?.ip).toBe('198.51.100.23');
    expect(ctx.db.select().from(sessions).all().some((s) => s.ip === '198.51.100.23')).toBe(true);

    // The signed-in pages are behind the proof of work (a different rule): one more challenge, then /welcome.
    expect(challengeOf(await c.get('/welcome'))?.rules.algorithm).toBe('fast');
    const welcome = await passProofOfWork(c, '/welcome');
    expect(fromPortal(welcome)).toBe(true);
  });
});

describe('the client address the portal sees', () => {
  it('IPv4, as nginx-proxy sends it', async () => {
    const c = new Client('203.0.113.61');
    await passProofOfWork(c, '/sign-in');
    const r = await requestSignInLink(c, 'someone@example.org');
    expect(r.status).toBe(200);
    expect(rateCount('magic_ip', '203.0.113.61')).toBe(1);
  });

  it('IPv6, as nginx-proxy sends it', async () => {
    const c = new Client('2001:db8:61:1::7');
    await passProofOfWork(c, '/sign-in');
    await requestSignInLink(c, 'someone@example.org');
    expect(rateCount('magic_ip', '2001:db8:61:1::7')).toBe(1);
  });

  it('ignores a forged X-Real-IP, a forged x-oc-client-ip and forged left-hand X-Forwarded-For entries', async () => {
    // As if nginx-proxy appended to a client-sent X-Forwarded-For (it
    // overwrites it; this is the belt to that brace) and passed a
    // client-sent X-Real-IP through untouched.
    const c = new Client('203.0.113.62', {
      'x-forwarded-for': '198.51.100.66, 203.0.113.62',
      'x-real-ip': '198.51.100.66',
      'x-oc-client-ip': '198.51.100.67',
    });
    await passProofOfWork(c, '/sign-in');
    await requestSignInLink(c, 'someone@example.org');
    expect(rateCount('magic_ip', '203.0.113.62')).toBe(1);
    expect(rateCount('magic_ip', '198.51.100.66')).toBe(0);
    expect(rateCount('magic_ip', '198.51.100.67')).toBe(0);
  });
});

describe('the emailed-link page takes only its Confirm action', () => {
  // Anubis gives /auth/email/* the light no-JavaScript challenge, and every
  // action of src/app/actions/auth.ts is callable on that page. The portal's
  // proxy lets through only the Confirm action there (src/lib/email-link-guard.ts).
  function actionId(exportedName: string): string {
    const m = JSON.parse(readFileSync(join(REPO, '.next', 'server', 'server-reference-manifest.json'), 'utf8')) as {
      node: Record<string, { exportedName?: string }>;
    };
    const id = Object.entries(m.node).find(([, v]) => v.exportedName === exportedName)?.[0];
    if (!id) throw new Error(`no ${exportedName} in the build's action manifest`);
    return id;
  }

  it('refuses another action id sent as a fetch action (Next-Action)', async () => {
    const ip = '203.0.113.71';
    const c = new Client(ip);
    await passMetaRefresh(c, '/auth/email/not-a-token');
    const fd = new FormData();
    fd.set('email', 'someone@example.org');
    const r = await c.post('/auth/email/not-a-token', fd, { 'next-action': actionId('magicLinkAction') });
    expect(challengeOf(r)).toBeNull(); // Anubis let it through; the portal refused it
    expect(r.status).toBe(403);
    expect(rateCount('magic_ip', ip)).toBe(0);
  });

  it('refuses to parse a form over 64 KiB, even one naming the Confirm action', async () => {
    const c = new Client('203.0.113.74');
    await passMetaRefresh(c, '/auth/email/not-a-token');
    const form = (pad: number) => {
      const fd = new FormData();
      fd.set(`$ACTION_ID_${actionId('confirmEmailLinkAction')}`, '');
      fd.set('pad', 'x'.repeat(pad));
      return fd;
    };
    expect((await c.post('/auth/email/not-a-token', form(70 * 1024))).status).toBe(403);
    // The same form at a normal size gets past the guard (and then fails in
    // the action itself, which wants a bound token: not a 403).
    expect((await c.post('/auth/email/not-a-token', form(10))).status).not.toBe(403);
  });

  it('refuses another action in a no-JavaScript form', async () => {
    const ip = '203.0.113.72';
    // The sign-in page's own form, fetched by a client that passed its proof of work...
    const signIn = new Client('203.0.113.73');
    const page = await passProofOfWork(signIn, '/sign-in');
    const fd = formWith(page.body, 'name="email"');
    fd.set('email', 'someone@example.org');
    expect(JSON.stringify([...fd.keys()])).toContain('$ACTION_REF_');
    // ...posted to the emailed-link page by one that only waited out the metarefresh.
    const c = new Client(ip);
    await passMetaRefresh(c, '/auth/email/not-a-token');
    const r = await c.post('/auth/email/not-a-token', fd);
    expect(challengeOf(r)).toBeNull();
    expect(r.status).toBe(403);
    expect(rateCount('magic_ip', ip)).toBe(0);
  });
});
