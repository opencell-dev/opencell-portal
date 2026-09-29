import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Layouts are not a security boundary in the App Router: every page and
// every server action checks the session itself (spec §13 "an admin-only
// route check for every admin page").

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? pages(p) : f === 'page.tsx' ? [p] : [];
  });
}

function exportedFunctions(file: string): [string, string][] {
  const src = readFileSync(file, 'utf8');
  return src
    .split(/(?=export async function )/)
    .slice(1)
    .map((chunk) => [chunk.match(/export async function (\w+)/)![1], chunk]);
}

const APP = 'src/app/(app)';

describe('route guards', () => {
  it('every admin page calls requireAdmin', () => {
    const admin = pages(join(APP, 'admin'));
    expect(admin.length).toBeGreaterThanOrEqual(2);
    for (const p of admin) expect(readFileSync(p, 'utf8'), p).toContain('await requireAdmin()');
  });

  it('every signed-in page calls requireUser or requireAdmin', () => {
    for (const p of pages(APP)) expect(readFileSync(p, 'utf8'), p).toMatch(/await require(User|Admin)\(\)/);
  });

  it('every admin action checks for a (fresh) admin', () => {
    const fns = exportedFunctions('src/app/actions/admin.ts');
    expect(fns.length).toBeGreaterThan(0);
    for (const [name, body] of fns) expect(body, name).toMatch(/await (freshAdmin|requireAdmin)\(\)/);
  });

  it('every account action checks for a signed-in user', () => {
    for (const [name, body] of exportedFunctions('src/app/actions/account.ts')) {
      expect(body, name).toContain('await requireUser()');
    }
  });
});
