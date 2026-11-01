import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CELL_CERT_DAYS, CELL_POLICY_OID, checkCsr, CSR_MAX_BYTES, loadCellCa, signCellCert } from '@/lib/ca/cell-ca';
import { type CellPki, makeCellPki, makeCsr } from '../helpers/cell-pki';
import { testCtx } from '../helpers/ctx';
import { CORE_DIR } from '../helpers/real-core';

let pki: CellPki;
beforeAll(() => {
  pki = makeCellPki();
});
afterAll(() => pki.done());

const ctxFor = (crt: string, key: string) => testCtx({ OC_CELL_CA_CERT: crt, OC_CELL_CA_KEY: key });
const ca = () => loadCellCa(ctxFor(pki.icaCrt, pki.icaKey))!;

function write(name: string, pem: string): string {
  const f = join(pki.dir, name);
  writeFileSync(f, pem);
  return f;
}

/** Each extension's lines, as `openssl x509 -ext` prints them; the two key ids' values dropped. */
function extensions(certFile: string): string {
  const out = pki.ossl('x509', '-in', certFile, '-noout', '-ext', 'basicConstraints,keyUsage,extendedKeyUsage,certificatePolicies,subjectKeyIdentifier,authorityKeyIdentifier');
  return out.replace(/(?:[0-9A-F]{2}:){19}[0-9A-F]{2}/g, 'KEYID');
}

describe('loadCellCa', () => {
  it('is null when nothing is configured', () => {
    expect(loadCellCa(testCtx())).toBeNull();
  });

  it('loads a good intermediate', () => {
    const c = ca();
    expect(c.certPem).toContain('BEGIN CERTIFICATE');
    expect(c.fpr).toMatch(/^[0-9a-f]{64}$/);
    expect(c.notAfter).toBeGreaterThan(Date.now());
  });

  it('refuses pathlen 1', () => {
    const i = pki.makeIca({ pathlen: 1 });
    expect(() => loadCellCa(ctxFor(i.crt, i.key))).toThrow(/cell CA: .*pathlen/);
  });

  it('refuses one without the cell policy', () => {
    const none = pki.makeIca({ policy: null });
    expect(() => loadCellCa(ctxFor(none.crt, none.key))).toThrow(/cell CA: .*polic/);
    const other = pki.makeIca({ policy: '2.25.39025894690731581968303886031091540846.1.1' });
    expect(() => loadCellCa(ctxFor(other.crt, other.key))).toThrow(/cell CA: .*polic/);
  });

  it('refuses one without clientAuth', () => {
    const none = pki.makeIca({ eku: null });
    expect(() => loadCellCa(ctxFor(none.crt, none.key))).toThrow(/cell CA: .*clientAuth/);
    const server = pki.makeIca({ eku: 'serverAuth' });
    expect(() => loadCellCa(ctxFor(server.crt, server.key))).toThrow(/cell CA: .*clientAuth/);
  });

  it('refuses an expired one', () => {
    const ctx = ctxFor(pki.icaCrt, pki.icaKey);
    const c = loadCellCa(ctx)!;
    ctx.clock.t = c.notAfter + 1;
    expect(() => loadCellCa(ctx)).toThrow(/cell CA: .*expired/);
  });

  it('refuses the wrong key', () => {
    const other = pki.makeIca();
    expect(() => loadCellCa(ctxFor(pki.icaCrt, other.key))).toThrow(/cell CA: .*key/);
  });

  it('refuses a leaf and a missing file', () => {
    const leaf = pki.ossl('req', '-x509', '-new', '-key', pki.icaKey, '-subj', '/CN=x', '-days', '2', '-addext', 'basicConstraints=critical,CA:FALSE');
    const f = write('leaf.crt', leaf);
    expect(() => loadCellCa(ctxFor(f, pki.icaKey))).toThrow(/cell CA: /);
    expect(() => loadCellCa(ctxFor(join(pki.dir, 'nope.crt'), pki.icaKey))).toThrow(/cell CA: /);
  });

  it('reloads when the file changes', () => {
    const a = pki.makeIca({ name: 'reload' });
    const ctx = ctxFor(a.crt, a.key);
    const first = loadCellCa(ctx)!;
    const b = pki.makeIca({ name: 'reload' });
    const later = new Date(Date.now() + 5000);
    execFileSync('touch', ['-d', later.toISOString(), b.crt]);
    expect(loadCellCa(ctx)!.fpr).not.toBe(first.fpr);
  });
});

describe('checkCsr', () => {
  it('takes a P-256 CSR', async () => {
    expect(await checkCsr(makeCsr(pki).csr)).toEqual({ ok: true });
  });

  it('refuses an RSA key', async () => {
    const r = await checkCsr(makeCsr(pki, { newkey: ['rsa:2048'] }).csr);
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining('P-256') });
  });

  it('refuses a P-384 key', async () => {
    const r = await checkCsr(makeCsr(pki, { newkey: ['ec', '-pkeyopt', 'ec_paramgen_curve:P-384'] }).csr);
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining('P-256') });
  });

  it('refuses a tampered CSR (a bad signature)', async () => {
    const { csr } = makeCsr(pki);
    const body = csr.split('\n').slice(1, -2).join('');
    const der = Buffer.from(body, 'base64');
    der[der.length - 3] ^= 0xff;
    const lines = der.toString('base64').match(/.{1,64}/g)!.join('\n');
    const r = await checkCsr(`-----BEGIN CERTIFICATE REQUEST-----\n${lines}\n-----END CERTIFICATE REQUEST-----\n`);
    expect(r.ok).toBe(false);
  });

  it('refuses a 5 KB body', async () => {
    const { csr } = makeCsr(pki);
    expect(CSR_MAX_BYTES).toBe(4096);
    expect((await checkCsr(csr + ' '.repeat(5000))).ok).toBe(false);
  });

  it('refuses two blocks, and text around a block', async () => {
    const { csr } = makeCsr(pki);
    expect((await checkCsr(csr + makeCsr(pki).csr)).ok).toBe(false);
    expect((await checkCsr(`hello\n${csr}`)).ok).toBe(false);
    expect((await checkCsr(`${csr}-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n`)).ok).toBe(false);
  });

  it.each(['', 'garbage', '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n'])('refuses %j', async (s) => {
    expect((await checkCsr(s)).ok).toBe(false);
  });
});

describe('signCellCert', () => {
  it('signs in the cell profile: the portal’s CN, the six extensions, 730 days, a chain to the root', async () => {
    const { csr } = makeCsr(pki, { subj: '/O=Evil/CN=core1.opencell.k4ozi.com' });
    const before = Date.now();
    const got = await signCellCert(ca(), csr, 'cell7-frederick-roof-2');
    const x = new X509Certificate(got.pem);
    expect(x.subject).toBe('O=OpenCell\nCN=cell7-frederick-roof-2');
    expect(x.issuer).toBe('O=OpenCell\nCN=OpenCell Cell CA 1');
    const crt = write('leaf.crt', got.pem);
    const text = pki.ossl('x509', '-in', crt, '-noout', '-text');
    expect(text.match(/X509v3 [A-Z][A-Za-z ]+:/g)?.sort()).toEqual([
      'X509v3 Authority Key Identifier:',
      'X509v3 Basic Constraints:',
      'X509v3 Certificate Policies:',
      'X509v3 Extended Key Usage:',
      'X509v3 Key Usage:',
      'X509v3 Subject Key Identifier:',
    ]);
    expect(text).toContain(`Policy: ${CELL_POLICY_OID}`);
    expect(text).toMatch(/Basic Constraints: critical\s+CA:FALSE/);
    expect(text).toMatch(/Key Usage: critical\s+Digital Signature/);
    expect(text).toMatch(/Extended Key Usage:\s+TLS Web Client Authentication/);
    expect(got.notAfter - got.notBefore).toBe(CELL_CERT_DAYS * 86_400_000);
    expect(Math.abs(got.notBefore - before)).toBeLessThan(60_000);
    expect(got.fpr).toMatch(/^[0-9a-f]{64}$/);
    expect(got.fpr).toBe(x.fingerprint256.replaceAll(':', '').toLowerCase());
    expect(got.serial).toMatch(/^[0-9A-F]+$/);
    const v = pki.ossl('verify', '-purpose', 'sslclient', '-CAfile', pki.rootCrt, '-untrusted', pki.icaCrt, crt);
    expect(v).toContain('OK');
  });

  it('never carries the CSR’s own extensions: a CA:TRUE request gets a CA:FALSE leaf', async () => {
    const { csr } = makeCsr(pki, { addext: ['basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign', 'subjectAltName=DNS:evil.example'] });
    const got = await signCellCert(ca(), csr, 'cell1-x');
    const text = pki.ossl('x509', '-in', write('leaf2.crt', got.pem), '-noout', '-text');
    expect(text).toMatch(/Basic Constraints: critical\s+CA:FALSE/);
    expect(text).not.toContain('Certificate Sign');
    expect(text).not.toContain('evil.example');
  });

  it('makes a different serial each time', async () => {
    const { csr } = makeCsr(pki);
    const a = await signCellCert(ca(), csr, 'cell1-x');
    const b = await signCellCert(ca(), csr, 'cell1-x');
    expect(a.serial).not.toBe(b.serial);
  });

  it.each(['', 'a/CN=b', 'a b', 'x'.repeat(65), 'a\nb', '../x;rm -rf'])('refuses a CN like %j', async (cn) => {
    await expect(signCellCert(ca(), makeCsr(pki).csr, cn)).rejects.toThrow();
  });

  it('refuses a key that is not P-256 even when called directly', async () => {
    await expect(signCellCert(ca(), makeCsr(pki, { newkey: ['rsa:2048'] }).csr, 'cell1-x')).rejects.toThrow(/P-256/);
  });

  it.skipIf(!CORE_DIR)('has the same extensions as oc-ca sign … cell', async () => {
    const { csr } = makeCsr(pki);
    const got = await signCellCert(ca(), csr, 'cell9-same');
    const out = join(pki.dir, 'oc-ca-cell.crt');
    execFileSync(join(CORE_DIR!, 'tools/ca/oc-ca'), ['sign', pki.rootDir, 'cell', write('same.csr', csr), out, 'cell9-same'], { stdio: 'pipe' });
    expect(extensions(write('same.crt', got.pem))).toBe(extensions(out));
  });
});
