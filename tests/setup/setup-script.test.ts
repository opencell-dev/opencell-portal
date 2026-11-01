import { execFileSync, spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issuedCerts, nodes, userRoles, users } from '@/db/schema';
import { submitRequest } from '@/lib/nodes/requests';
import { publishRelease } from '@/lib/nodes/release';
import { approveRequest } from '@/lib/nodes/review';
import { handleCsr, handleScript, handleTarball } from '@/lib/nodes/setup';
import { makeSetupToken } from '@/lib/nodes/setup-tokens';
import { type CellPki, makeCellPki } from '../helpers/cell-pki';
import { testCtx, type TestCtx } from '../helpers/ctx';

// The script end to end on a system of stubs (tests/setup/stubs: apt-get,
// systemctl, useradd, groupadd, cmake, chown, runuser, getent, id, uname), and
// real curl, openssl, tar, sha256sum and awk, against a server that calls the same
// handlers as the routes: what `curl … | sudo bash` does on a Pi, in a prefix.

const META = { ip: '203.0.113.9' };
const GOOD = { siteName: 'Frederick Roof', lat: '39.414371', lon: '-77.410541', region: 'MD', piModel: 'pi5', w12Boards: '1', gps: true, antenna: 'Vertical', backhaul: 'home', power: 'mains', contactPhone: '+13015550100', agree: true, agreementVersion: 1 };
const STUBS = resolve('tests/setup/stubs');
const BOARD1 = 'usb-Espressif_USB_JTAG_serial_debug_unit_44:B1:76:00:00:01-if00';
const BOARD2 = 'usb-Espressif_USB_JTAG_serial_debug_unit_44:B1:76:00:00:02-if00';

let pki: CellPki;
let tgz: string;
let server: Server;
let origin = '';
let ctx: TestCtx;
let nodeId: number;
/** What the server was sent, in order. */
let seen: { method: string; url: string; body: string }[];
let root: string;
let log: string;

beforeAll(async () => {
  pki = makeCellPki();
  tgz = join(pki.dir, 'release.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', 'tests/fixtures/oc-cell-release', '.']);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        seen.push({ method: req.method ?? '', url: req.url ?? '', body: body.toString() });
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        headers.set('x-oc-client-ip', '203.0.113.9');
        const r = new Request(`${origin}${req.url}`, { method: req.method, headers, ...(req.method === 'POST' ? { body } : {}) });
        const m = /^\/setup\/([^/]+)(\/oc-cell\.tgz|\/csr)?$/.exec(req.url ?? '');
        const out = !m ? new Response('no', { status: 404 }) : m[2] === '/csr' ? await handleCsr(ctx, m[1], r) : m[2] ? await handleTarball(ctx, m[1], r) : await handleScript(ctx, m[1], r);
        res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
        res.end(Buffer.from(await out.arrayBuffer()));
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  pki.done();
});

beforeEach(async () => {
  seen = [];
  root = mkdtempSync(join(tmpdir(), 'oc-setup-root-'));
  log = join(root, 'stub.log');
  writeFileSync(log, '');
  mkdirSync(join(root, 'etc'), { recursive: true });
  writeFileSync(join(root, 'etc/os-release'), 'ID=debian\nVERSION_ID="13"\n');
  mkdirSync(join(root, 'dev/serial/by-id'), { recursive: true });
  writeFileSync(join(root, 'dev/serial/by-id', BOARD1), '');
  ctx = testCtx({ OC_ORIGIN: origin, OC_RP_ID: '127.0.0.1', OC_CELL_CA_CERT: pki.icaCrt, OC_CELL_CA_KEY: pki.icaKey, OC_CORE_CA: pki.rootCrt, OC_RELEASE_DIR: join(root, 'releases') });
  publishRelease(ctx, tgz, 'v0.2.0');
  const a = ctx.db.insert(users).values({ name: 'Root', email: 'root@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  ctx.db.insert(userRoles).values({ userId: a, role: 'admin', grantedAt: 1 }).run();
  const u = ctx.db.insert(users).values({ name: 'Alice', email: 'alice@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  const req = submitRequest(ctx, u, GOOD, META);
  if (!req.ok) throw new Error(req.error);
  const ap = await approveRequest(ctx, a, req.id, { coreId: 'fake', anchor: 30, boardRole: 'bs' }, META);
  if (!ap.ok) throw new Error(ap.error);
  nodeId = ap.nodeId;
});

function run(cmd: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn('bash', ['-c', cmd], {
      env: { PATH: `${STUBS}:${process.env.PATH}`, OC_STUB_LOG: log, OC_SETUP_TEST: '1', OC_SETUP_PREFIX: root, OC_SETUP_SKIP_APT: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (out += d));
    child.on('close', (code) => done({ code: code ?? -1, out }));
  });
}

const setup = (token: string, args = '', env: Record<string, string> = {}) => run(`set -o pipefail; curl -fsSL ${origin}/setup/${token} | bash ${args}`, env);
const etc = (f: string) => join(root, 'etc/opencell', f);
const stubLog = () => readFileSync(log, 'utf8');
const pubkey = (keyFile: string) => pki.ossl('pkey', '-in', keyFile, '-pubout');
const csrs = () => seen.filter((s) => s.method === 'POST');
const fresh = () => makeSetupToken(ctx, nodeId, null).token;

describe('the setup script on a stubbed Pi', () => {
  it('installs, makes the key here, asks for a certificate and starts the service', async () => {
    const r = await setup(fresh());
    expect(r.out).toContain('Done. Watch it come online on My nodes');
    expect(r.code).toBe(0);
    const lib = join(root, 'usr/local/lib/opencell/oc-cell');
    expect(execFileSync(join(lib, 'v0.2.0/bin/oc-cell')).toString().trim()).toBe('oc-cell v0.2.0');
    expect(readlinkSync(join(lib, 'current'))).toBe('v0.2.0');
    expect(readlinkSync(join(root, 'usr/local/bin/oc-cell'))).toBe('../lib/opencell/oc-cell/current/bin/oc-cell');
    expect(existsSync(join(lib, 'previous'))).toBe(false);
    expect(readFileSync(join(root, 'etc/systemd/system/oc-cell.service'), 'utf8')).toContain('fixture oc-cell');
    expect(readFileSync(join(root, 'etc/systemd/system.conf.d/10-opencell-cpus.conf'), 'utf8')).toContain('CPUAffinity');

    // The key is here; the server only ever saw a CSR for it.
    expect(existsSync(etc('cell.key'))).toBe(true);
    expect(existsSync(etc('cell.key.new'))).toBe(false);
    const key = readFileSync(etc('cell.key'), 'utf8');
    expect(csrs()).toHaveLength(1);
    expect(csrs()[0].body).toContain('BEGIN CERTIFICATE REQUEST');
    for (const s of seen) {
      expect(s.body).not.toContain('PRIVATE KEY');
      expect(s.body).not.toContain(key.split('\n')[1]);
    }
    const csrFile = join(root, 'seen.csr');
    writeFileSync(csrFile, csrs()[0].body);
    expect(pki.ossl('req', '-in', csrFile, '-noout', '-pubkey')).toBe(pubkey(etc('cell.key')));

    const conf = readFileSync(etc('oc-cell.conf'), 'utf8');
    expect(conf).toContain(`board = /dev/serial/by-id/${BOARD1}\n`);
    const n = ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()!;
    expect(conf).toContain(`cell_id = ${n.cellId}\n`);
    expect(conf).toContain('core = cells.fake.invalid:7443\n');
    expect(conf).toContain('sync_ch = 30\n');
    expect(conf).not.toContain('@BOARD@');

    const crt = readFileSync(etc('cell.crt'), 'utf8');
    expect(crt.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(new X509Certificate(crt).fingerprint256.replaceAll(':', '').toLowerCase()).toBe(n.certFpr);
    expect(readFileSync(etc('ca.crt'), 'utf8')).toBe(readFileSync(pki.rootCrt, 'utf8'));
    for (const f of ['oc-cell.conf', 'cell.crt', 'cell.key', 'ca.crt']) expect(lstatSync(etc(f)).mode & 0o777).toBe(0o640);
    expect(lstatSync(join(root, 'etc/opencell')).mode & 0o777).toBe(0o750);

    const l = stubLog();
    expect(l).toContain('groupadd -f oc-cell');
    expect(l).toContain('useradd --system -g oc-cell -G dialout --no-create-home --shell /usr/sbin/nologin oc-cell');
    expect(l).toContain('chown root:oc-cell');
    expect(l).toContain('systemctl daemon-reload');
    expect(l).toContain('systemctl enable --now oc-cell');
    expect(l).toContain('runuser -u nobody -- cmake -S');
    expect(l).toContain('-DOC_PI_TESTS=OFF -DOC_VERSION=v0.2.0');
    expect(l).not.toContain('apt-get');
    expect(l.split('\n').filter((x) => x.startsWith('systemctl restart'))).toEqual([]);
  });

  it('asks apt for the packages the appendix lists', async () => {
    expect((await setup(fresh(), '', { OC_SETUP_SKIP_APT: '0' })).code).toBe(0);
    expect(stubLog()).toContain('apt-get install -y --no-install-recommends cmake make gcc libc6-dev libssl-dev libsqlite3-dev openssl ca-certificates curl');
  });

  it('a re-run with a new token keeps the key and skips the build, and restarts the service', async () => {
    expect((await setup(fresh())).code).toBe(0);
    const before = readFileSync(etc('cell.key'), 'utf8');
    const fprBefore = ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()!.certFpr;
    writeFileSync(log, '');
    seen = [];
    const r = await setup(fresh());
    expect(r.code).toBe(0);
    expect(readFileSync(etc('cell.key'), 'utf8')).toBe(before);
    expect(stubLog()).not.toContain('cmake');
    expect(seen.some((s) => s.url.endsWith('oc-cell.tgz'))).toBe(false);
    expect(stubLog()).toContain('systemctl restart oc-cell');
    // A new certificate for the same key: the pin moved to it.
    const n = ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()!;
    expect(n.certFpr).not.toBe(fprBefore);
    expect((await ctx.core.cellStatus(0, n.cellId))[0].certFpr).toBe(n.certFpr);
  });

  it('--new-key makes a new key, and the certificate is for it', async () => {
    expect((await setup(fresh())).code).toBe(0);
    const before = pubkey(etc('cell.key'));
    const r = await setup(fresh(), '-s -- --new-key');
    expect(r.code).toBe(0);
    const after = pubkey(etc('cell.key'));
    expect(after).not.toBe(before);
    expect(existsSync(etc('cell.key.new'))).toBe(false);
    const crtFile = join(root, 'leaf.pem');
    writeFileSync(crtFile, readFileSync(etc('cell.crt')));
    expect(pki.ossl('x509', '-in', crtFile, '-noout', '-pubkey')).toBe(after);
  });

  it('--new-key that gets no certificate leaves the old key and certificate alone', async () => {
    expect((await setup(fresh())).code).toBe(0);
    const key = readFileSync(etc('cell.key'), 'utf8');
    const crt = readFileSync(etc('cell.crt'), 'utf8');
    ctx.core.simDown('refuse');
    const r = await setup(fresh(), '-s -- --new-key');
    ctx.core.simDown(null);
    expect(r.code).toBe(1);
    expect(r.out).toContain("The network didn't answer");
    expect(readFileSync(etc('cell.key'), 'utf8')).toBe(key);
    expect(readFileSync(etc('cell.crt'), 'utf8')).toBe(crt);
  });

  it('with no board: exit 1 before the CSR, and the token still works', async () => {
    rmSync(join(root, 'dev/serial/by-id', BOARD1));
    const t = fresh();
    const r = await setup(t);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no OpenCell W12 board');
    expect(csrs()).toEqual([]);
    expect(existsSync(etc('cell.key'))).toBe(false);
    writeFileSync(join(root, 'dev/serial/by-id', BOARD1), '');
    expect((await setup(t)).code).toBe(0);
  });

  it('with two boards: exit 1, listing both, and the token still works', async () => {
    writeFileSync(join(root, 'dev/serial/by-id', BOARD2), '');
    const r = await setup(fresh());
    expect(r.code).toBe(1);
    expect(r.out).toContain(BOARD1);
    expect(r.out).toContain(BOARD2);
    expect(csrs()).toEqual([]);
  });

  it.each([
    ['not root', 'id', 'echo 1000', 'as root'],
    ['not a Pi', 'uname', 'echo x86_64', 'Raspberry Pi'],
  ])('stops when %s', async (_w, stub, body, word) => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-stub-'));
    writeFileSync(join(dir, stub), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    const r = await setup(fresh(), '', { PATH: `${dir}:${STUBS}:${process.env.PATH}` });
    expect(r.code).toBe(1);
    expect(r.out).toContain(word);
    expect(stubLog()).toBe('');
  });

  it.each([
    ['ID=debian\nVERSION_ID="11"\n', 'Debian 12'],
    ['ID=fedora\nVERSION_ID="40"\n', 'Debian 12'],
  ])('stops on an unsupported system: %j', async (osRelease, word) => {
    writeFileSync(join(root, 'etc/os-release'), osRelease);
    const r = await setup(fresh());
    expect(r.code).toBe(1);
    expect(r.out).toContain(word);
  });

  it('takes Raspbian’s own name for it', async () => {
    writeFileSync(join(root, 'etc/os-release'), 'ID=raspbian\nID_LIKE=debian\nVERSION_ID="12"\n');
    expect((await setup(fresh())).code).toBe(0);
  });

  it('refuses a download that does not match its hash, before the CSR', async () => {
    const t = fresh();
    const script = await (await handleScript(ctx, t, new Request(`${origin}/setup/${t}`))).text();
    const f = join(root, 'bad.sh');
    writeFileSync(f, script.replace(/SHA256='[0-9a-f]{64}'/, `SHA256='${'0'.repeat(64)}'`));
    const r = await run(`bash ${f}`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not match');
    expect(csrs()).toEqual([]);
  });

  it('a truncated script runs nothing', async () => {
    const t = fresh();
    const script = await (await handleScript(ctx, t, new Request(`${origin}/setup/${t}`))).text();
    const half = join(root, 'half.sh');
    for (const cut of [Math.floor(script.length / 2), script.length - 'main "$@"\n'.length]) {
      writeFileSync(half, script.slice(0, cut));
      // bash reports a syntax error (cut inside a function), or just defines it all.
      const r = await run(`cat ${half} | bash`);
      expect([0, 2]).toContain(r.code);
      expect(existsSync(join(root, 'usr'))).toBe(false);
      expect(existsSync(etc('cell.key'))).toBe(false);
      expect(stubLog()).toBe('');
      expect(csrs()).toEqual([]);
    }
  });

  it('takes no bundle part by any other name', async () => {
    const t = fresh();
    const script = await (await handleScript(ctx, t, new Request(`${origin}/setup/${t}`))).text();
    // The same awk the script runs, on a bundle naming another file.
    const awk = /awk -v dir="\$WORK\/parts" '([\s\S]*?)' "\$WORK\/bundle"/.exec(script)![1];
    const dir = mkdtempSync(join(tmpdir(), 'oc-awk-'));
    const evil = join(dir, 'bundle');
    writeFileSync(evil, '--- ../../etc/cron.d/x\nboom\n');
    const r = await run(`awk -v dir=${dir}/parts '${awk}' ${evil}`);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(dir, 'parts'))).toBe(false);
  });

  it('a certificate the portal issued is on record, pinned', async () => {
    expect((await setup(fresh())).code).toBe(0);
    expect(ctx.db.select().from(issuedCerts).where(eq(issuedCerts.nodeId, nodeId)).all()).toEqual([expect.objectContaining({ pinned: true })]);
  });
});
