// The pinned Anubis release (deploy/anubis/release.env), fetched once into
// the user's cache and checked the way lxc-bootstrap checks the .deb: the
// pinned SHA-256, and (when gpgv is installed) the release signature by the
// pinned key in deploy/anubis/techaro-packages.asc.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(import.meta.dirname, '..', '..');
export const ANUBIS_DIR = join(REPO, 'deploy', 'anubis');

/** KEY=value lines (comments and blank lines skipped), as systemd's EnvironmentFile reads them. */
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) throw new Error(`${path}: not KEY=value: ${raw}`);
    out[line.slice(0, eq)] = line.slice(eq + 1).replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hasGpgv(): boolean {
  try {
    execFileSync('gpgv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  renameSync(tmp, dest);
}

/** The path of the pinned linux-amd64 anubis binary, downloading and verifying it on first use. */
export async function anubisBinary(): Promise<string> {
  const pin = readEnvFile(join(ANUBIS_DIR, 'release.env'));
  const version = pin.ANUBIS_VERSION;
  const want = pin.ANUBIS_TARBALL_SHA256_LINUX_AMD64;
  if (!version || !want) throw new Error('deploy/anubis/release.env lacks ANUBIS_VERSION or ANUBIS_TARBALL_SHA256_LINUX_AMD64');
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('the Anubis test pins the linux-amd64 build only');

  const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'oc-portal', 'anubis', version);
  mkdirSync(cache, { recursive: true });
  const name = `anubis-${version}-linux-amd64`;
  const tarball = join(cache, `${name}.tar.gz`);
  const bin = join(cache, name, 'bin', 'anubis');
  const url = `https://github.com/TecharoHQ/anubis/releases/download/v${version}/${name}.tar.gz`;
  if (!existsSync(tarball) || sha256(tarball) !== want) await download(url, tarball);
  if (!existsSync(`${tarball}.asc`)) await download(`${url}.asc`, `${tarball}.asc`);

  const got = sha256(tarball);
  if (got !== want) throw new Error(`${tarball}: sha256 ${got}, pinned ${want}`);
  if (hasGpgv()) {
    const home = mkdtempSync(join(tmpdir(), 'oc-anubis-gpg-'));
    try {
      const keyring = join(home, 'techaro.gpg');
      execFileSync('gpg', ['--batch', '--quiet', '--homedir', home, '--dearmor', '-o', keyring, join(ANUBIS_DIR, 'techaro-packages.asc')]);
      const status = execFileSync('gpgv', ['--status-fd', '1', '--keyring', keyring, `${tarball}.asc`, tarball], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!new RegExp(`^\\[GNUPG:\\] VALIDSIG .* ${pin.ANUBIS_SIGNING_KEY_FPR}$`, 'm').test(status)) {
        throw new Error(`${tarball}: not signed by the pinned key ${pin.ANUBIS_SIGNING_KEY_FPR}`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  // Re-extract whenever the binary is missing (the tarball is the checked artifact).
  if (!existsSync(bin)) {
    execFileSync('tar', ['-xzf', tarball, '-C', cache, `${name}/bin/anubis`]);
    chmodSync(bin, 0o755);
  }
  return bin;
}
