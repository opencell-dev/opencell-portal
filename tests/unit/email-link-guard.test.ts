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

function mpa(fields: [string, string][]): Request {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  return new Request('https://portal.test/auth/email/tok', { method: 'POST', body: fd });
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
    expect(await isConfirmActionRequest(mpa(ref(CONFIRM)), ids)).toBe(true);
    expect(await isConfirmActionRequest(mpa(ref(MAGIC)), ids)).toBe(false);
    expect(await isConfirmActionRequest(mpa([['$ACTION_ID_' + CONFIRM, '']]), ids)).toBe(true);
    expect(await isConfirmActionRequest(mpa([['$ACTION_ID_' + SIGNUP, ''], ['email', 'a@b.c']]), ids)).toBe(false);
  });

  it('refuses anything ambiguous or indirect', async () => {
    // A second action key: React takes the last one.
    expect(await isConfirmActionRequest(mpa([['$ACTION_ID_' + CONFIRM, ''], ['$ACTION_ID_' + MAGIC, '']]), ids)).toBe(false);
    // The id as a reply reference ("$1") rather than the literal id.
    const indirect: [string, string][] = [
      ['$ACTION_REF_1', ''],
      ['$ACTION_1:0', JSON.stringify({ id: '$1', bound: null })],
      ['$ACTION_1:1', JSON.stringify(CONFIRM)],
    ];
    expect(await isConfirmActionRequest(mpa(indirect), ids)).toBe(false);
    expect(await isConfirmActionRequest(mpa([['$ACTION_REF_1', ''], ['$ACTION_1:0', '{oops']]), ids)).toBe(false);
    expect(await isConfirmActionRequest(mpa([['$ACTION_REF_1', '']]), ids)).toBe(false);
    expect(await isConfirmActionRequest(mpa([['email', 'a@b.c']]), ids)).toBe(false);
    const urlencoded = post({ 'content-type': 'application/x-www-form-urlencoded' }, `$ACTION_ID_${CONFIRM}=`);
    expect(await isConfirmActionRequest(urlencoded, ids)).toBe(false);
    expect(await isConfirmActionRequest(mpa([['$ACTION_ID_' + CONFIRM, '']]), new Set())).toBe(false);
    expect(await isConfirmActionRequest(new Request('https://portal.test/auth/email/tok', { method: 'PUT', body: 'x' }), ids)).toBe(false);
  });

  it('leaves the body for the page to read', async () => {
    const r = mpa([['$ACTION_ID_' + CONFIRM, ''], ['email', 'a@b.c']]);
    expect(await isConfirmActionRequest(r, ids)).toBe(true);
    expect((await r.formData()).get('email')).toBe('a@b.c');
  });
});
