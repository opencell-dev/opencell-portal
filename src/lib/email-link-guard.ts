// The emailed-link page (/auth/email/<token>) takes one unsafe request: its
// Confirm button's server action. In front of the portal, Anubis gives this
// page only its light no-JavaScript challenge (so links work from any mail
// client), and Next.js serves every action of a module the page imports
// there — all of src/app/actions/auth.ts: sign-up, sign-in links, passkey
// sign-in. Without this guard, waiting out that light challenge would open
// all of them. So the proxy lets a request through only if it is plainly the
// confirm action, and 403s anything else.
//
// Next.js has no API for an action's id, so it comes from the manifest the
// build writes (.next/server/server-reference-manifest.json: id -> source
// file and export name), reread when the file changes (dev rebuilds). No
// manifest, no match: every unsafe request to the page is refused.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CONFIRM = { filename: 'src/app/actions/auth.ts', exportedName: 'confirmEmailLinkAction' };
/** next.config.ts's serverActions.bodySizeLimit ('64kb'): a Confirm form is a few hundred bytes. */
export const MAX_FORM_BYTES = 64 * 1024;
const EMAIL_LINK_PATH = /^\/auth\/email\/[^/]+$/;

export function isEmailLinkPath(pathname: string): boolean {
  return EMAIL_LINK_PATH.test(pathname);
}

/** The confirm action's ids (node and edge layers) in a parsed server-reference manifest. */
export function confirmActionIds(manifest: unknown): Set<string> {
  const ids = new Set<string>();
  if (!manifest || typeof manifest !== 'object') return ids;
  for (const layer of ['node', 'edge'] as const) {
    const entries = (manifest as Record<string, unknown>)[layer];
    if (!entries || typeof entries !== 'object') continue;
    for (const [id, v] of Object.entries(entries)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as { filename?: unknown; exportedName?: unknown };
      if (e.filename === CONFIRM.filename && e.exportedName === CONFIRM.exportedName) ids.add(id);
    }
  }
  return ids;
}

export function defaultManifestPath(): string {
  return join(process.cwd(), '.next', 'server', 'server-reference-manifest.json');
}

let cache: { path: string; mtimeMs: number; ids: Set<string> } | null = null;
let warned = false;

/**
 * The confirm action's ids from the build's manifest. Empty (refuse all) if
 * it has never been read; after a later read error, the ids last read (the
 * running build has not changed).
 */
export function loadConfirmActionIds(path = defaultManifestPath()): Set<string> {
  try {
    const { mtimeMs } = statSync(path);
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.ids;
    const ids = confirmActionIds(JSON.parse(readFileSync(path, 'utf8')));
    cache = { path, mtimeMs, ids };
    if (ids.size === 0) throw new Error('no confirmEmailLinkAction in it');
    warned = false;
    return ids;
  } catch (e) {
    if (!warned) {
      console.error(`oc-portal: email-link guard: ${path}: ${(e as Error).message}; refusing every POST to /auth/email/*`);
      warned = true;
    }
    return cache?.path === path ? cache.ids : new Set();
  }
}

/**
 * Whether `req` is the confirm action and nothing else: as a fetch action,
 * its Next-Action header; as a no-JavaScript form (multipart), every action
 * key React would look at ($ACTION_ID_<id>, or $ACTION_REF_<n> with the
 * literal id in $ACTION_<n>:0) names it. Reads a clone of the body, and
 * only one with a Content-Length of at most MAX_FORM_BYTES.
 */
export async function isConfirmActionRequest(req: Request, ids: Set<string>): Promise<boolean> {
  if (req.method !== 'POST' || ids.size === 0) return false;
  const header = req.headers.get('next-action');
  if (header !== null) return ids.has(header);
  if (!(req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) return false;
  // Parse nothing Next would refuse anyway: Next clones up to 10 MB of body
  // for the proxy, and anyone who waited out the metarefresh can send it.
  const length = req.headers.get('content-length');
  if (length === null || !/^\d{1,9}$/.test(length) || Number(length) > MAX_FORM_BYTES) return false;
  let form: FormData;
  try {
    form = await req.clone().formData();
  } catch {
    return false;
  }
  const found: string[] = [];
  for (const key of form.keys()) {
    if (key.startsWith('$ACTION_ID_')) found.push(key.slice('$ACTION_ID_'.length));
    else if (key.startsWith('$ACTION_REF_')) {
      const meta = form.get(`$ACTION_${key.slice('$ACTION_REF_'.length)}:0`);
      try {
        const id: unknown = typeof meta === 'string' ? JSON.parse(meta)?.id : undefined;
        found.push(typeof id === 'string' ? id : '');
      } catch {
        return false;
      }
    }
  }
  return found.length > 0 && found.every((id) => ids.has(id));
}
