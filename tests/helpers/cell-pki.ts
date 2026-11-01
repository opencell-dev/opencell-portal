import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CELL_POLICY_OID } from '@/lib/ca/cell-ca';
import { CORE_DIR } from './real-core';

// A test PKI for the cell certificates (plan P3): a root as oc-ca makes it
// (the core's own oc-ca when OC_CORE_DIR is set; the same openssl commands
// otherwise) and an intermediate in the Global Constraints' profile. The tests'
// keys are their own, in a temp dir.

export interface IcaOptions {
  name?: string;
  /** Default 0. */
  pathlen?: number;
  /** Null: leave the policy out. */
  policy?: string | null;
  /** Null: leave the EKU out. */
  eku?: string | null;
  days?: number;
  /** Sign with another root's directory. */
  rootDir?: string;
}

export interface CellPki {
  dir: string;
  rootDir: string;
  rootCrt: string;
  icaCrt: string;
  icaKey: string;
  ossl: (...args: string[]) => string;
  makeIca: (o?: IcaOptions) => { crt: string; key: string };
  makeRoot: (name: string) => string;
  done: () => void;
}

export function makeCellPki(): CellPki {
  const dir = mkdtempSync(join(tmpdir(), 'oc-cell-pki-'));
  const ossl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' }).toString();
  const makeRoot = (name: string) => {
    const rootDir = join(dir, name);
    if (CORE_DIR) {
      execFileSync(join(CORE_DIR, 'tools/ca/oc-ca'), ['init', rootDir], { stdio: 'pipe' });
      return rootDir;
    }
    mkdirSync(rootDir, { recursive: true });
    ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(rootDir, 'ca.key'));
    writeFileSync(
      join(rootDir, 'ca.cnf'),
      '[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nO = OpenCell\nCN = OpenCell Root CA\n[root]\nbasicConstraints = critical, CA:TRUE, pathlen:1\nkeyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\n',
    );
    ossl('req', '-x509', '-new', '-key', join(rootDir, 'ca.key'), '-sha256', '-days', '3650', '-config', join(rootDir, 'ca.cnf'), '-extensions', 'root', '-out', join(rootDir, 'ca.crt'));
    return rootDir;
  };
  const rootDir = makeRoot('root');
  let n = 0;
  const makeIca = (o: IcaOptions = {}) => {
    const name = o.name ?? `ica${n++}`;
    const key = join(dir, `${name}.key`);
    const crt = join(dir, `${name}.crt`);
    const root = o.rootDir ?? rootDir;
    ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key);
    ossl('req', '-new', '-key', key, '-subj', '/O=OpenCell/CN=OpenCell Cell CA 1', '-out', join(dir, `${name}.csr`));
    const lines = [
      '[ica]',
      `basicConstraints = critical, CA:TRUE, pathlen:${o.pathlen ?? 0}`,
      'keyUsage = critical, keyCertSign, cRLSign',
      ...(o.eku === null ? [] : [`extendedKeyUsage = ${o.eku ?? 'clientAuth'}`]),
      ...(o.policy === null ? [] : [`certificatePolicies = ${o.policy ?? CELL_POLICY_OID}`]),
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid',
    ];
    writeFileSync(join(dir, `${name}.cnf`), `${lines.join('\n')}\n`);
    ossl('x509', '-req', '-in', join(dir, `${name}.csr`), '-CA', join(root, 'ca.crt'), '-CAkey', join(root, 'ca.key'), '-sha256', '-days', String(o.days ?? 365), '-set_serial', `0x${Date.now().toString(16)}${n}`, '-extfile', join(dir, `${name}.cnf`), '-extensions', 'ica', '-out', crt);
    return { crt, key };
  };
  const ica = makeIca({ name: 'ica' });
  return { dir, rootDir, rootCrt: join(rootDir, 'ca.crt'), icaCrt: ica.crt, icaKey: ica.key, ossl, makeIca, makeRoot, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A new key and a CSR for it, made as the Pi makes them (or with any other key algorithm), in PEM. */
export function makeCsr(pki: CellPki, o: { newkey?: string[]; subj?: string; addext?: string[] } = {}): { csr: string; key: string } {
  const t = mkdtempSync(join(pki.dir, 'csr-'));
  const key = join(t, 'k.pem');
  const newkey = o.newkey ?? ['ec', '-pkeyopt', 'ec_paramgen_curve:P-256'];
  const out = join(t, 'c.pem');
  pki.ossl('req', '-new', '-newkey', ...newkey, '-nodes', '-keyout', key, '-subj', o.subj ?? '/CN=oc-cell', ...(o.addext ?? []).flatMap((e) => ['-addext', e]), '-out', out);
  const read = (f: string) => execFileSync('cat', [f]).toString();
  return { csr: read(out), key: read(key) };
}
