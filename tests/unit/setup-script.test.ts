import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Release } from '@/lib/nodes/release';
import { bundleText, cellConf, renderSetupScript } from '@/lib/nodes/setup';
import type { Node } from '@/lib/nodes/setup-tokens';
import { testCtx } from '../helpers/ctx';

const TOKEN = 'A'.repeat(21) + '-_' + 'b'.repeat(20);
const REL: Release = { tag: 'v0.2.0', sha256: 'a'.repeat(64), path: '/x', bytes: 1 };

const NODE = { id: 12, cellId: 7, siteName: 'Frederick Roof', boardRole: 'bs', cellSeed: 0x1234abcd, anchor: 3 } as Node;

describe('the setup script', () => {
  const ctx = testCtx();
  const script = renderSetupScript(ctx, TOKEN, REL);

  it('passes bash -n', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'oc-script-')), 's.sh');
    writeFileSync(f, script);
    expect(spawnSync('bash', ['-n', f]).status).toBe(0);
    const which = spawnSync('which', ['shellcheck']);
    if (which.status === 0) {
      const sc = spawnSync('shellcheck', ['-S', 'warning', f], { encoding: 'utf8' });
      expect(sc.stdout).toBe('');
    }
  });

  it('runs main only at its very last line (a truncated download runs nothing)', () => {
    const lines = script.trimEnd().split('\n');
    expect(lines.at(-1)).toBe('main "$@"');
    expect(lines.filter((l) => l === 'main "$@"')).toHaveLength(1);
  });

  it('holds its values single-quoted at the top, before any function', () => {
    const head = script.slice(0, script.indexOf('die()'));
    expect(head).toContain("ORIGIN='https://portal.test'");
    expect(head).toContain(`TOKEN='${TOKEN}'`);
    expect(head).toContain("TAG='v0.2.0'");
    expect(head).toContain(`SHA256='${'a'.repeat(64)}'`);
    expect(script).not.toContain('@VALUES@');
  });

  it('sends the Origin with the CSR', () => {
    expect(script).toMatch(/curl [^\n]*-H "Origin: \$ORIGIN"[^\n]*"\$ORIGIN\/setup\/\$TOKEN\/csr"/);
  });

  it('whitelists the bundle’s file names', () => {
    expect(script).toContain('name != "oc-cell.crt" && name != "ca.crt" && name != "oc-cell.conf"');
  });

  it.each(['', 'short', `${'A'.repeat(42)}'`, `${'A'.repeat(42)}$`, `${'A'.repeat(42)};`, `${'A'.repeat(42)}\n`, 'A'.repeat(44), "$(reboot)".padEnd(43, 'A')])('refuses a token like %j', (t) => {
    expect(() => renderSetupScript(ctx, t, REL)).toThrow();
  });

  it.each(['v1', 'v1.2', '1.2.3', "v1.2.3'", 'v1.2.3;x', 'v1.2.3\n', '$(x)'])('refuses a tag like %j', (tag) => {
    expect(() => renderSetupScript(ctx, TOKEN, { ...REL, tag })).toThrow();
  });

  it.each(['', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}'`, 'a'.repeat(65)])('refuses a SHA-256 like %j', (sha256) => {
    expect(() => renderSetupScript(ctx, TOKEN, { ...REL, sha256 })).toThrow();
  });

  it('refuses an origin it could not quote', () => {
    const bad = { ...ctx, config: { ...ctx.config, origin: "https://x'; reboot; '" } };
    expect(() => renderSetupScript(bad, TOKEN, REL)).toThrow();
  });

  it('does not run with a value it has not validated', () => {
    // A quote can't reach the script: the values are the only thing interpolated.
    const out = execFileSync('bash', ['-c', `${script.slice(0, script.indexOf('die()'))}\necho "$ORIGIN $TAG"`], { encoding: 'utf8' });
    expect(out.trim()).toBe('https://portal.test v0.2.0');
  });
});

describe('the configuration a node gets', () => {
  it('is exactly the plan’s, in oc-cell’s keys', () => {
    expect(cellConf(NODE, 'core1.opencell.k4ozi.com:47443')).toBe(
      [
        '# /etc/opencell/oc-cell.conf, written by the OpenCell portal for node 12 (Frederick Roof)',
        'cell_id = 7',
        'core = core1.opencell.k4ozi.com:47443',
        'radio = board',
        'board = @BOARD@',
        'board_role = bs',
        'board_reset = 1',
        'cell_seed = 0x1234abcd',
        'tier = edge',
        'dl_band = 915',
        'ul_band = 915',
        'mode = part15',
        'sync_ch = 3',
        'cert = /etc/opencell/cell.crt',
        'key = /etc/opencell/cell.key',
        'ca = /etc/opencell/ca.crt',
        '',
      ].join('\n'),
    );
  });

  it('pads the seed to 8 hex digits', () => {
    expect(cellConf({ ...NODE, cellSeed: 0x1f }, 'a:1')).toContain('cell_seed = 0x0000001f\n');
  });

  it('bundles the parts in the file names the script splits', () => {
    expect(bundleText({ cert: 'LEAF\n', chain: 'ICA', ca: 'ROOT\n', conf: 'CONF\n' })).toBe('--- oc-cell.crt\nLEAF\nICA\n--- ca.crt\nROOT\n--- oc-cell.conf\nCONF\n');
  });
});
