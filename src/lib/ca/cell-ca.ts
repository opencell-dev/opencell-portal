import { execFile, execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialPath } from '@/core/tls-client';
import type { Ctx } from '@/lib/ctx';

// The online cell intermediate (portal spec §8.3; plan P3, decisions 5, 28). It
// signs cell certificates only, from a CSR made on the Pi, with exactly oc-ca's
// `cell` extensions (tools/ca/oc-ca in opencell-core), so a cell certificate
// reads the same whichever CA issued it. The subject and every extension come
// from here: nothing of the CSR but its public key reaches the certificate.
//
// `openssl` runs by execFile with a fixed argument list and the CSR on stdin:
// no shell ever sees a value. The key stays in its file (a systemd credential
// on the guest): only openssl reads it, and it is never logged or kept here.

export const CELL_POLICY_OID = '2.25.39025894690731581968303886031091540846.1.3';
export const CELL_CERT_DAYS = 730;
export const CSR_MAX_BYTES = 4096;

const CN = /^[A-Za-z0-9._-]{1,64}$/;
const OPENSSL_MS = 10_000;
const OPENSSL_MAX_OUTPUT = 64 * 1024;
// One CSR and nothing else: a second block, or anything around the block, is refused before openssl sees it.
const ONE_CSR = /^-----BEGIN CERTIFICATE REQUEST-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE REQUEST-----\s*$/;

// The block oc-ca writes for role cell, word for word.
const CELL_EXT = `[role]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
certificatePolicies = ${CELL_POLICY_OID}
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`;

export interface CellCa {
  certPem: string;
  certPath: string;
  keyPath: string;
  notAfter: number;
  fpr: string;
}

const fprOf = (x: X509Certificate) => x.fingerprint256.replaceAll(':', '').toLowerCase();

/** Run openssl with this argument list and, if given, this on stdin; its stdout, or a rejection that quotes nothing of what it was given. */
function openssl(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('openssl', args, { timeout: OPENSSL_MS, maxBuffer: OPENSSL_MAX_OUTPUT }, (err, stdout) => {
      if (err) reject(new Error(`openssl ${args[0]} failed (${err.code ?? 'killed'})`));
      else resolve(stdout);
    });
    // A child that has already gone must not take the process with it.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

interface Loaded {
  stamp: string;
  ca: CellCa;
}

// One per process, as __ocCores is: Next can load this module more than once.
const g = globalThis as typeof globalThis & { __ocCellCa?: Map<string, Loaded> };

function readCa(certPath: string, keyPath: string): CellCa {
  let certPem: string;
  try {
    certPem = readFileSync(certPath, 'utf8');
  } catch {
    throw new Error(`cell CA: the certificate ${certPath} cannot be read`);
  }
  let x: X509Certificate;
  try {
    x = new X509Certificate(certPem);
  } catch {
    throw new Error(`cell CA: ${certPath} is not a certificate`);
  }
  let ext: string;
  try {
    ext = execFileSync('openssl', ['x509', '-noout', '-ext', 'basicConstraints,extendedKeyUsage,certificatePolicies'], { input: certPem, timeout: OPENSSL_MS, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch {
    throw new Error('cell CA: openssl could not read the certificate');
  }
  if (!/Basic Constraints: critical\s+CA:TRUE, pathlen:0\b/.test(ext)) throw new Error('cell CA: it must be CA:TRUE, pathlen:0 (critical)');
  if (!/Extended Key Usage:\s+TLS Web Client Authentication\s*$/m.test(ext)) throw new Error('cell CA: it must carry the extended key usage clientAuth and only that');
  if (!ext.includes(`Policy: ${CELL_POLICY_OID}`)) throw new Error('cell CA: it lacks the cell certificate policy');
  let keyOk = false;
  try {
    keyOk = x.checkPrivateKey(createPrivateKey(readFileSync(keyPath)));
  } catch {
    throw new Error('cell CA: the key cannot be read');
  }
  if (!keyOk) throw new Error('cell CA: the key does not match the certificate');
  return { certPem, certPath, keyPath, notAfter: new Date(x.validTo).getTime(), fpr: fprOf(x) };
}

/**
 * The configured intermediate, or null when none is configured. A configured
 * one that is not fit to sign (not CA:TRUE/pathlen:0, no policy or clientAuth,
 * expired, the wrong key) throws `cell CA: …`, so nothing is ever signed with
 * it. Checked once per file version; the expiry at every call.
 */
export function loadCellCa(ctx: Ctx): CellCa | null {
  const c = ctx.config.cellCa;
  if (!c) return null;
  const certPath = credentialPath(c.cert);
  const keyPath = credentialPath(c.key);
  let stamp: string;
  try {
    stamp = `${statSync(certPath).mtimeMs}:${statSync(keyPath).mtimeMs}`;
  } catch {
    throw new Error('cell CA: the certificate or key file is missing');
  }
  g.__ocCellCa ??= new Map();
  const key = `${certPath}\0${keyPath}`;
  let hit = g.__ocCellCa.get(key);
  if (hit?.stamp !== stamp) {
    hit = { stamp, ca: readCa(certPath, keyPath) };
    g.__ocCellCa.set(key, hit);
  }
  if (hit.ca.notAfter <= ctx.now()) throw new Error('cell CA: it has expired');
  return hit.ca;
}

export type CsrCheck = { ok: true } | { ok: false; why: string };

/** One CSR block, at most 4096 bytes, whose signature verifies, with an ECDSA P-256 key. */
export async function checkCsr(pem: string): Promise<CsrCheck> {
  if (Buffer.byteLength(pem) > CSR_MAX_BYTES) return { ok: false, why: `A CSR is at most ${CSR_MAX_BYTES} bytes.` };
  if (!ONE_CSR.test(pem)) return { ok: false, why: 'Send exactly one PEM certificate request.' };
  try {
    await openssl(['req', '-noout', '-verify'], pem);
  } catch {
    return { ok: false, why: 'That certificate request does not verify.' };
  }
  let pub: string;
  try {
    pub = await openssl(['req', '-noout', '-pubkey'], pem);
  } catch {
    return { ok: false, why: 'That certificate request has no readable key.' };
  }
  try {
    const k = createPublicKey(pub);
    if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return { ok: false, why: 'The key must be ECDSA P-256.' };
  } catch {
    return { ok: false, why: 'The key must be ECDSA P-256.' };
  }
  return { ok: true };
}

export interface SignedCell {
  pem: string;
  fpr: string;
  serial: string;
  notBefore: number;
  notAfter: number;
}

/** A cell certificate for this CSR's key, named `cn` (the portal's, never the CSR's): oc-ca's cell profile, 730 days, a random 15-byte serial. */
export async function signCellCert(ca: CellCa, csrPem: string, cn: string): Promise<SignedCell> {
  if (!CN.test(cn)) throw new Error('cell CA: that is not a certificate name');
  const check = await checkCsr(csrPem);
  if (!check.ok) throw new Error(`cell CA: ${check.why}`);
  const dir = mkdtempSync(join(tmpdir(), 'oc-cell-ca-'));
  try {
    const extfile = join(dir, 'ext.cnf');
    writeFileSync(extfile, CELL_EXT, { mode: 0o600 });
    const pem = await openssl(
      ['x509', '-req', '-in', '-', '-CA', ca.certPath, '-CAkey', ca.keyPath, '-sha256', '-days', String(CELL_CERT_DAYS), '-set_serial', `0x${randomBytes(15).toString('hex')}`, '-subj', `/O=OpenCell/CN=${cn}`, '-extfile', extfile, '-extensions', 'role'],
      csrPem,
    );
    const x = new X509Certificate(pem);
    return { pem, fpr: fprOf(x), serial: x.serialNumber, notBefore: new Date(x.validFrom).getTime(), notAfter: new Date(x.validTo).getTime() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** For the admin dashboard: is there an intermediate, and until when; or what is wrong with it. */
export function cellCaInfo(ctx: Ctx): { configured: false } | { configured: true; notAfter: number; fpr: string } | { configured: true; problem: string } {
  if (!ctx.config.cellCa) return { configured: false };
  try {
    const ca = loadCellCa(ctx);
    return ca ? { configured: true, notAfter: ca.notAfter, fpr: ca.fpr } : { configured: false };
  } catch (e) {
    return { configured: true, problem: (e as Error).message };
  }
}
