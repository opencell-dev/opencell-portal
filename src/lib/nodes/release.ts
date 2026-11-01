import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { settings } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';

// The published oc-cell source (plan P3, decisions 3 and 4): the Pi repo's tagged
// tree with its submodules, packed on the laptop and published to the guest
// with oc-portal-admin cell-release. The setup script pins its SHA-256.

export const RELEASE_KEY = 'cell_release';

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
