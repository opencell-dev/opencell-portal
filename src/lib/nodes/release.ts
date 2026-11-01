import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { settings } from '@/db/schema';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';

// The published oc-cell source (plan P3, decisions 3 and 4): the Pi repo's tagged
// tree with its submodules, packed on the laptop and published to the guest
// with oc-portal-admin cell-release. The setup script pins its SHA-256.

export const RELEASE_KEY = 'cell_release';
export const TAG_RE = /^v\d+\.\d+\.\d+$/;
const LIST_MAX = 128 * 1024 * 1024;

export interface Release {
  tag: string;
  sha256: string;
  path: string;
  bytes: number;
}

export const releasePath = (ctx: Ctx, tag: string) => resolve(join(ctx.config.releaseDir, `oc-cell-${tag}.tgz`));

/** What is published now, or null: nothing yet, or its file is gone or the wrong size. */
export function currentRelease(ctx: Ctx): Release | null {
  const row = ctx.db.select().from(settings).where(eq(settings.key, RELEASE_KEY)).get();
  if (!row) return null;
  const r = JSON.parse(row.value) as { tag: string; sha256: string; bytes: number };
  const path = releasePath(ctx, r.tag);
  try {
    if (statSync(path).size !== r.bytes) return null;
  } catch {
    return null;
  }
  return { tag: r.tag, sha256: r.sha256, bytes: r.bytes, path };
}

/**
 * Publish a packed release (a gzip tar, oc-deploy's pack): it must hold oc-cell,
 * its unit, and the TLS link (PI-1). Copied in whole, then named; the release
 * before it stays, older ones go. Throws with a plain message.
 */
export function publishRelease(ctx: Ctx, file: string, tag: string): { tag: string; sha256: string; bytes: number } {
  if (!TAG_RE.test(tag)) throw new Error(`'${tag}': a release's tag is vX.Y.Z`);
  let names: Set<string>;
  try {
    names = new Set(execFileSync('tar', ['-tzf', file], { maxBuffer: LIST_MAX, stdio: ['ignore', 'pipe', 'pipe'] }).toString().split('\n'));
  } catch {
    throw new Error(`${file} is not a gzip tar`);
  }
  for (const need of ['./oc-cell/occ_main.c', './dist/systemd/oc-cell.service', './oc-cell/occ_cfg.h']) {
    if (!names.has(need)) throw new Error(`${file} has no ${need}: it is not a packed opencell-pi tag`);
  }
  const cfg = execFileSync('tar', ['-xzOf', file, './oc-cell/occ_cfg.h'], { maxBuffer: LIST_MAX, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  if (!cfg.includes('cert =')) throw new Error(`${tag}'s oc-cell has no \`cert =\` key: it needs the TLS link (opencell-pi v0.2.0 or newer)`);
  const dir = ctx.config.releaseDir;
  mkdirSync(dir, { recursive: true });
  const body = readFileSync(file);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const bytes = body.length;
  const path = releasePath(ctx, tag);
  const tmp = `${path}.new`;
  copyFileSync(file, tmp);
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
  const before = currentRelease(ctx)?.tag;
  const value = JSON.stringify({ tag, sha256, bytes });
  ctx.db.insert(settings).values({ key: RELEASE_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  const keep = new Set([`oc-cell-${tag}.tgz`, ...(before ? [`oc-cell-${before}.tgz`] : [])]);
  for (const f of readdirSync(dir)) {
    if (/^oc-cell-v.*\.tgz$/.test(f) && !keep.has(f)) rmSync(join(dir, f), { force: true });
  }
  writeAudit(ctx, { actorId: null, action: 'cell.release', target: tag, detail: { sha256, bytes } });
  return { tag, sha256, bytes };
}
