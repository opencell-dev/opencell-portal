import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TlsCore } from '@/core/tls-client';
import type { ContractCore } from './core-contract';

/**
 * A built opencell-core checkout (build/oc/oc-core, tools/ca/oc-ca), or
 * undefined: then the tests against a real core are skipped. Set it to run
 * them: OC_CORE_DIR=~/Documents/opencell/core npm test
 */
export const CORE_DIR = process.env.OC_CORE_DIR ? resolve(process.env.OC_CORE_DIR) : undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const newKey = (n: string) =>
  ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${n}.key`, '-subj', `/CN=${n}`, '-out', `${n}.csr`];

/**
 * A test OpenCell CA (the core's own oc-ca) and one portal certificate:
 * what every test core trusts and pins. Two cores given the same one are
 * set up as production is (plan P4b: the same portal certificate on both).
 */
export interface TestPki {
  caDir: string;
  caCrt: string;
  portalCrt: string;
  portalKey: string;
  portalFpr: string;
}

export function makeTestPki(dir: string = CORE_DIR!): TestPki & { done: () => void } {
  const t = mkdtempSync(join(tmpdir(), 'oc-test-pki-'));
  const ocCa = join(dir, 'tools/ca/oc-ca');
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: t, stdio: 'pipe' }).toString();
  run(ocCa, ['init', join(t, 'ca')]);
  run('openssl', newKey('portal'));
  const fpr = run(ocCa, ['sign', join(t, 'ca'), 'portal', 'portal.csr', 'portal.crt', 'oc-portal']).trim().split(' ')[1];
  return {
    caDir: join(t, 'ca'),
    caCrt: join(t, 'ca/ca.crt'),
    portalCrt: join(t, 'portal.crt'),
    portalKey: join(t, 'portal.key'),
    portalFpr: fpr,
    done: () => rmSync(t, { recursive: true, force: true }),
  };
}

export interface RealCoreOptions {
  /** Shared with other cores; by default the core makes its own. */
  pki?: TestPki;
  coreId?: number;
  name?: string;
  /** PREFIX INDEX: the block the core is home for. */
  block?: string;
}

export type RealCore = ContractCore & { adminSocket: string; port: number; pid: number; log: () => string };

/**
 * oc-core on 127.0.0.1 with its admin API on, in a temp directory: the
 * core's certificate from a test CA, the portal certificate pinned in its
 * config, one block at home (8831717 by default); and a TlsCore to it.
 */
export async function startRealCore(dir: string = CORE_DIR!, opts: RealCoreOptions = {}): Promise<RealCore> {
  const t = mkdtempSync(join(tmpdir(), 'oc-real-core-'));
  const ocCore = join(dir, 'build/oc/oc-core');
  const ocCa = join(dir, 'tools/ca/oc-ca');
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: t, stdio: 'pipe' }).toString();
  const own = opts.pki ? undefined : makeTestPki(dir);
  const pki = opts.pki ?? own!;
  run('openssl', newKey('core'));
  run(ocCa, ['sign', pki.caDir, 'core', 'core.csr', 'core.crt', 'localhost', '--dns', 'localhost', '--ip', '127.0.0.1']);
  writeFileSync(join(t, 'master.key'), randomBytes(32));
  chmodSync(join(t, 'master.key'), 0o400);
  const port = await freePort();
  writeFileSync(
    join(t, 'oc-core.conf'),
    [
      `core_id = ${opts.coreId ?? 1}`,
      'key_id = 1',
      `name = ${opts.name ?? 'oc-core-test'}`,
      `block = ${opts.block ?? '8831717 1'}`,
      // Core v0.3 (network-core §22) wants its service numbers in a block it is
      // home for; v0.2 takes the line too. The echo is NPA-555-00100 of the block.
      `echo = +${(opts.block ?? '8831717 1').split(' ')[0]}55500100`,
      `cell_socket = ${t}/core.sock`,
      `admin_socket = ${t}/admin.sock`,
      `api_listen = 127.0.0.1:${port}`,
      `api_cert = ${t}/core.crt`,
      `api_key = ${t}/core.key`,
      `api_ca = ${pki.caCrt}`,
      `api_portal_fpr = ${pki.portalFpr}`,
      '',
    ].join('\n'),
  );
  const base = ['--config', join(t, 'oc-core.conf'), '--key-file', join(t, 'master.key'), '--db', join(t, 'core.db')];
  run(ocCore, ['admin', '--offline', ...base.slice(0, 4), '--db', join(t, 'core.db'), 'net', 'init']);
  const logFd = openSync(join(t, 'log'), 'a');
  const proc: ChildProcess = spawn(ocCore, base, { stdio: ['ignore', logFd, logFd] });
  const core = new TlsCore({
    host: '127.0.0.1',
    port,
    servername: 'localhost',
    ca: pki.caCrt,
    cert: pki.portalCrt,
    key: pki.portalKey,
    timeoutMs: 3000,
  });
  const log = () => readFileSync(join(t, 'log'), 'utf8');
  let stopped = false;
  const done = async () => {
    // Idempotent (review M5): a caller may stop the core early in a test and
    // again in afterAll. Also check signalCode, not just exitCode — a
    // process that died by signal never sets exitCode, so a second call
    // (without `stopped`) would still try to await a fresh 'exit' listener
    // on a process whose 'exit' event already fired, and hang forever.
    if (stopped) return;
    stopped = true;
    core.close();
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((r) => {
        proc.once('exit', () => r());
        proc.kill('SIGTERM');
      });
    }
    rmSync(t, { recursive: true, force: true });
    own?.done();
  };
  for (let i = 0; ; i++) {
    try {
      await core.coreStatus(0);
      break;
    } catch (e) {
      if (i >= 50 || proc.exitCode !== null) {
        const text = log();
        await done();
        throw new Error(`oc-core did not come up: ${(e as Error).message}\n${text}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { core, done, log, port, pid: proc.pid!, adminSocket: join(t, 'admin.sock') };
}
