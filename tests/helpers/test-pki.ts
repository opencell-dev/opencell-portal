import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway PKI for the TLS tests: dir holds NAME.key/NAME.crt. */
export interface TestPki {
  dir: string;
  path(name: string): string;
  read(name: string): Buffer;
}

function openssl(dir: string, ...args: string[]) {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

/**
 * ca (a root), server (localhost / 127.0.0.1, serverAuth), client
 * (clientAuth), and rogue-ca + rogue-server (another root) - made with the
 * openssl command line, ECDSA P-256, as tools/ca/oc-ca in opencell-core does.
 */
export function makeTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'oc-pki-'));
  const root = (name: string) => {
    openssl(dir, 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`);
    openssl(dir, 'req', '-x509', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-days', '2',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-out', `${name}.crt`);
  };
  const leaf = (ca: string, name: string, ext: string) => {
    openssl(dir, 'req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', `${name}.key`, '-subj', `/CN=${name}`, '-out', `${name}.csr`);
    writeFileSync(join(dir, `${name}.ext`), `[e]\nbasicConstraints=critical,CA:FALSE\n${ext}\n`);
    openssl(dir, 'x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.crt`, '-CAkey', `${ca}.key`, '-set_serial',
      String(Date.now()), '-days', '2', '-extfile', `${name}.ext`, '-extensions', 'e', '-out', `${name}.crt`);
  };
  root('ca');
  leaf('ca', 'server', 'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1');
  leaf('ca', 'client', 'extendedKeyUsage=clientAuth');
  root('rogue-ca');
  leaf('rogue-ca', 'rogue-server', 'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1');
  return { dir, path: (n) => join(dir, n), read: (n) => readFileSync(join(dir, n)) };
}
