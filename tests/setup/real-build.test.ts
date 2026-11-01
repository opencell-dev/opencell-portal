import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userRoles, users } from '@/db/schema';
import { submitRequest } from '@/lib/nodes/requests';
import { publishRelease } from '@/lib/nodes/release';
import { approveRequest } from '@/lib/nodes/review';
import { handleCsr, handleScript, handleTarball } from '@/lib/nodes/setup';
import { makeSetupToken } from '@/lib/nodes/setup-tokens';
import { type CellPki, makeCellPki } from '../helpers/cell-pki';
import { testCtx, type TestCtx } from '../helpers/ctx';

// The real thing where it can be: OC_PI_DIR=<a checkout of opencell-pi with its
// submodules> packs OC_PI_TAG (default v0.2.0) with deploy/oc-portal-cell-release,
// publishes it, and runs the setup script with the real cmake and compiler (only
// the system's privileged commands are stubs). Minutes, so it is opt-in.
const PI_DIR = process.env.OC_PI_DIR ? resolve(process.env.OC_PI_DIR) : undefined;
const TAG = process.env.OC_PI_TAG ?? 'v0.2.0';

describe.skipIf(!PI_DIR)('the setup script builds a real opencell-pi tag', () => {
  let pki: CellPki;
  let server: Server;
  let ctx: TestCtx;
  let origin = '';
  let root = '';

  beforeAll(async () => {
    pki = makeCellPki();
    root = mkdtempSync(join(tmpdir(), 'oc-real-setup-'));
    const tgz = join(root, 'release.tgz');
    execFileSync('deploy/oc-portal-cell-release', [PI_DIR!, TAG, 'guest'], { env: { ...process.env, OC_CELL_RELEASE_OUT: tgz }, stdio: 'pipe' });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const headers = new Headers({ 'x-oc-client-ip': '203.0.113.9' });
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const r = new Request(`${origin}${req.url}`, { method: req.method, headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
          const m = /^\/setup\/([^/]+)(\/oc-cell\.tgz|\/csr)?$/.exec(req.url ?? '')!;
          const out = m[2] === '/csr' ? await handleCsr(ctx, m[1], r) : m[2] ? await handleTarball(ctx, m[1], r) : await handleScript(ctx, m[1], r);
          res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
          res.end(Buffer.from(await out.arrayBuffer()));
        })();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ctx = testCtx({ OC_ORIGIN: origin, OC_RP_ID: '127.0.0.1', OC_CELL_CA_CERT: pki.icaCrt, OC_CELL_CA_KEY: pki.icaKey, OC_CORE_CA: pki.rootCrt, OC_RELEASE_DIR: join(root, 'releases') });
    publishRelease(ctx, tgz, TAG);
  }, 120_000);

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    pki.done();
  });

  it('installs a binary that says its tag, in the layout oc-deploy takes over', async () => {
    const a = ctx.db.insert(users).values({ name: 'Root', email: 'root@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
    ctx.db.insert(userRoles).values({ userId: a, role: 'admin', grantedAt: 1 }).run();
    const u = ctx.db.insert(users).values({ name: 'Alice', email: 'alice@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
    const req = submitRequest(ctx, u, { siteName: 'Bench', lat: '39.4', lon: '-77.4', region: 'MD', piModel: 'pi5', w12Boards: '1', gps: false, antenna: 'Whip', backhaul: 'home', power: 'mains', contactPhone: '+13015550100', agree: true, agreementVersion: 1 }, { ip: '203.0.113.9' });
    if (!req.ok) throw new Error(req.error);
    const ap = await approveRequest(ctx, a, req.id, { coreId: 'fake', anchor: 12, boardRole: 'bench' }, { ip: '203.0.113.9' });
    if (!ap.ok) throw new Error(ap.error);

    // Every stub but cmake.
    const stubs = join(root, 'stubs');
    mkdirSync(stubs);
    for (const f of readdirSync('tests/setup/stubs')) if (f !== 'cmake') copyFileSync(join('tests/setup/stubs', f), join(stubs, f));
    const log = join(root, 'stub.log');
    writeFileSync(log, '');
    mkdirSync(join(root, 'etc'), { recursive: true });
    writeFileSync(join(root, 'etc/os-release'), 'ID=debian\nVERSION_ID="13"\n');
    mkdirSync(join(root, 'dev/serial/by-id'), { recursive: true });
    writeFileSync(join(root, 'dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_44:B1:76:00:00:01-if00'), '');

    const token = makeSetupToken(ctx, ap.nodeId, null).token;
    const { code, out } = await new Promise<{ code: number; out: string }>((done) => {
      const child = spawn('bash', ['-c', `set -o pipefail; curl -fsSL ${origin}/setup/${token} | bash`], {
        env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, OC_STUB_LOG: log, OC_SETUP_TEST: '1', OC_SETUP_PREFIX: root, OC_SETUP_SKIP_APT: '1' },
      });
      let o = '';
      child.stdout?.on('data', (d: Buffer) => (o += d));
      child.stderr?.on('data', (d: Buffer) => (o += d));
      child.on('close', (c) => done({ code: c ?? -1, out: o }));
    });
    expect(code, out.slice(-3000)).toBe(0);
    const lib = join(root, 'usr/local/lib/opencell/oc-cell');
    expect(execFileSync(join(lib, TAG, 'bin/oc-cell'), ['--version']).toString().trim()).toBe(`oc-cell ${TAG}`);
    expect(existsSync(join(lib, TAG, 'oc-cell.service'))).toBe(true);
    expect(readFileSync(join(root, 'etc/systemd/system/oc-cell.service'), 'utf8')).toContain('ExecStart=/usr/local/bin/oc-cell --config /etc/opencell/oc-cell.conf');
    expect(readFileSync(join(root, 'etc/opencell/oc-cell.conf'), 'utf8')).toContain('sync_ch = 12\n');
  }, 900_000);
});
