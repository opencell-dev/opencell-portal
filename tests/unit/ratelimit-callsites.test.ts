import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

// A client address must go through hitIp (a limit that declares perIp, so
// IPv6 is bucketed by /64); `hit` with an address would count each IPv6
// address on its own.
describe('rate-limit call sites', () => {
  it('never pass a client address to hit()', () => {
    const offenders = sources('src').flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ f, i: i + 1, line }))
        .filter(({ line }) => /\bhit\([^)]*\b(meta\.ip|ip)\b/.test(line)),
    );
    expect(offenders.map(({ f, i, line }) => `${f}:${i}: ${line.trim()}`)).toEqual([]);
  });
});
