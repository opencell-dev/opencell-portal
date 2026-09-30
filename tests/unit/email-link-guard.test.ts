import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { confirmActionIds, isConfirmActionRequest, isEmailLinkPath, loadConfirmActionIds } from '@/lib/email-link-guard';
import { CONFIRM, MAGIC, MANIFEST, SIGNUP } from '../helpers/action-manifest';

const dir = mkdtempSync(join(tmpdir(), 'oc-guard-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function post(headers: Record<string, string>, body?: BodyInit): Request {
  return new Request('https://portal.test/auth/email/tok', { method: 'POST', headers, body });
}

/** A no-JavaScript form POST as a browser sends it: multipart, with its Content-Length. */
async function mpa(fields: [string, string][], length?: string | null): Promise<Request> {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  const encoded = new Request('https://x/', { method: 'POST', body: fd });
  const body = Buffer.from(await encoded.arrayBuffer());
  const headers: Record<string, string> = { 'content-type': encoded.headers.get('content-type') ?? '' };
  if (length !== null) headers['content-length'] = length ?? String(body.length);
  return new Request('https://portal.test/auth/email/tok', { method: 'POST', headers, body });
}

const ids = new Set([CONFIRM]);

describe('the emailed-link page accepts only its own Confirm action', () => {
  it('knows the email-link paths', () => {
    expect(isEmailLinkPath('/auth/email/abc')).toBe(true);
    expect(isEmailLinkPath('/auth/email/abc/x')).toBe(false);
    expect(isEmailLinkPath('/auth/email/')).toBe(false);
    expect(isEmailLinkPath('/sign-in')).toBe(false);
  });

  it('finds the confirm action in the manifest by file and export name, nothing else', () => {
    expect([...confirmActionIds(MANIFEST)]).toEqual([CONFIRM]);
    expect(confirmActionIds({}).size).toBe(0);
    expect(confirmActionIds(null).size).toBe(0);
    expect(confirmActionIds({ node: { [CONFIRM]: 'nonsense' } }).size).toBe(0);
  });

  it('loads the manifest from disk, fails closed when it is missing or unreadable, and rereads it when it changes', () => {
    const f = join(dir, 'server-reference-manifest.json');
    expect(loadConfirmActionIds(f).size).toBe(0);
    writeFileSync(f, '{not json');
    expect(loadConfirmActionIds(f).size).toBe(0);
    writeFileSync(f, JSON.stringify(MANIFEST));
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect([...loadConfirmActionIds(f)]).toEqual([CONFIRM]);
  });

  it('a fetch action: only the confirm id in Next-Action', async () => {
    expect(await isConfirmActionRequest(post({ 'next-action': CONFIRM }, 'x'), ids)).toBe(true);
    expect(await isConfirmActionRequest(post({ 'next-action': MAGIC }, 'x'), ids)).toBe(false);
    expect(await isConfirmActionRequest(post({ 'next-action': '' }, 'x'), ids)).toBe(false);
  });

  it('a no-JavaScript form: the bound-action reference must name the confirm id', async () => {
    const ref = (id: string): [string, string][] => [
      ['$ACTION_REF_1', ''],
      ['$ACTION_1:0', JSON.stringify({ id, bound: '$@1' })],
      ['$ACTION_1:1', '["token"]'],
      ['$ACTION_KEY', 'k1'],
    ];
    expect(await isConfirmActionRequest(await mpa(ref(CONFIRM)), ids)).toBe(true);
    expect(await isConfirmActionRequest(await mpa(ref(MAGIC)), ids)).toBe(false);
    expect(await isConfirmActionRequest(await mpa([['$ACTION_ID_' + CONFIRM, '']]), ids)).toBe(true);
    expect(await isConfirmActionRequest(await mpa([['$ACTION_ID_' + SIGNUP, ''], ['email', 'a@b.c']]), ids)).toBe(false);
  });

  it('refuses anything ambiguous or indirect', async () => {
    // A second action key: React takes the last one.
    expect(await isConfirmActionRequest(await mpa([['$ACTION_ID_' + CONFIRM, ''], ['$ACTION_ID_' + MAGIC, '']]), ids)).toBe(false);
    // The id as a reply reference ("$1") rather than the literal id.
    const indirect: [string, string][] = [
      ['$ACTION_REF_1', ''],
      ['$ACTION_1:0', JSON.stringify({ id: '$1', bound: null })],
      ['$ACTION_1:1', JSON.stringify(CONFIRM)],
    ];
    expect(await isConfirmActionRequest(await mpa(indirect), ids)).toBe(false);
    expect(await isConfirmActionRequest(await mpa([['$ACTION_REF_1', ''], ['$ACTION_1:0', '{oops']]), ids)).toBe(false);
    expect(await isConfirmActionRequest(await mpa([['$ACTION_REF_1', '']]), ids)).toBe(false);
    expect(await isConfirmActionRequest(await mpa([['email', 'a@b.c']]), ids)).toBe(false);
    const urlencoded = post({ 'content-type': 'application/x-www-form-urlencoded' }, `$ACTION_ID_${CONFIRM}=`);
    expect(await isConfirmActionRequest(urlencoded, ids)).toBe(false);
    expect(await isConfirmActionRequest(await mpa([['$ACTION_ID_' + CONFIRM, '']]), new Set())).toBe(false);
    expect(await isConfirmActionRequest(new Request('https://portal.test/auth/email/tok', { method: 'PUT', body: 'x' }), ids)).toBe(false);
  });

  it('refuses to parse a form without a Content-Length or larger than 64 KiB (Next\'s own action limit)', async () => {
    const ok: [string, string][] = [['$ACTION_ID_' + CONFIRM, '']];
    expect(await isConfirmActionRequest(await mpa(ok, null), ids)).toBe(false);
    expect(await isConfirmActionRequest(await mpa(ok, 'lots'), ids)).toBe(false);
    expect(await isConfirmActionRequest(await mpa(ok, '-1'), ids)).toBe(false);
    const big: [string, string][] = [...ok, ['pad', 'x'.repeat(64 * 1024)]];
    expect(await isConfirmActionRequest(await mpa(big), ids)).toBe(false);
    const fits: [string, string][] = [...ok, ['pad', 'x'.repeat(60 * 1024)]];
    expect(await isConfirmActionRequest(await mpa(fits), ids)).toBe(true);
  });

  it('leaves the body for the page to read', async () => {
    const r = await mpa([['$ACTION_ID_' + CONFIRM, ''], ['email', 'a@b.c']]);
    expect(await isConfirmActionRequest(r, ids)).toBe(true);
    expect((await r.formData()).get('email')).toBe('a@b.c');
  });
});
