import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { credentialPath } from '@/core/tls-client';
import { issuedCerts, nodes, nodeState } from '@/db/schema';
import { writeAudit } from '@/lib/audit';
import { type CellCa, checkCsr, CSR_MAX_BYTES, loadCellCa, type SignedCell, signCellCert } from '@/lib/ca/cell-ca';
import { tryWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { errorKind } from '@/lib/errors';
import { nodeCertMail } from '@/lib/mail-templates';
import { hitIp } from '@/lib/ratelimit';
import { coreActor } from '@/lib/site';
import { getUser } from '@/lib/users';
import { currentRelease, type Release, TAG_RE } from './release';
import { claimToken, type Node, peekToken, releaseClaim, TOKEN_RE, type TokenRefusal } from './setup-tokens';

// One command on a Pi (portal spec §6.3): the script, the source tarball and the
// CSR, three plain routes under /setup/<token> (src/app/setup). Nothing here
// needs a session: the token in the path is the bearer. The script is
// src/content/oc-cell-setup.sh with four validated, single-quoted values at the
// top; its last line runs it, so a truncated download runs nothing.

const WRITE_MS = 5000;
const NO_CERTS = "Certificates aren't available right now. Please try again later.\n";
const NO_RELEASE = 'Setup opens when the cell software is published. Please try again later.\n';
const NO_ANSWER = "The network didn't answer. Run the command again in a minute.\n";
const SHA256_RE = /^[0-9a-f]{64}$/;
// What a shell's single quotes can hold as they are; what URL.origin can be.
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

const TEXT = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

const REFUSED: Record<TokenRefusal, { status: 404 | 410; body: string }> = {
  unknown: { status: 404, body: 'This setup command is not valid. Make a new one on My nodes.\n' },
  expired: { status: 410, body: 'This setup command has expired. Make a new one on My nodes.\n' },
  used: { status: 410, body: 'This setup command has been used. Make a new one on My nodes.\n' },
  revoked: { status: 410, body: 'This node has been revoked. Write to opencell@k4ozi.com.\n' },
  tries: { status: 410, body: 'This setup command has failed too many times. Make a new one on My nodes.\n' },
};

const text = (status: number, body: string) => new Response(body, { status, headers: TEXT });

let scriptBody: string | undefined;

function scriptTemplate(): string {
  // WorkingDirectory is the release (the deploy keeps the whole tree).
  scriptBody ??= readFileSync(join(process.cwd(), 'src/content/oc-cell-setup.sh'), 'utf8');
  return scriptBody;
}

/** The script for this token and release. Throws if a value isn't exactly what it should be: none of them can break out of its quotes. */
export function renderSetupScript(ctx: Ctx, token: string, rel: Release): string {
  if (!TOKEN_RE.test(token)) throw new Error('setup script: not a token');
  if (!TAG_RE.test(rel.tag)) throw new Error('setup script: not a tag');
  if (!SHA256_RE.test(rel.sha256)) throw new Error('setup script: not a SHA-256');
  const origin = ctx.config.origin;
  if (!ORIGIN_RE.test(origin)) throw new Error('setup script: not an origin');
  const values = `ORIGIN='${origin}'\nTOKEN='${token}'\nTAG='${rel.tag}'\nSHA256='${rel.sha256}'`;
  return scriptTemplate().replace('#@VALUES@', () => values);
}

/** The node's /etc/opencell/oc-cell.conf; @BOARD@ is filled in on the Pi. */
export function cellConf(node: Pick<Node, 'id' | 'siteName' | 'cellId' | 'boardRole' | 'cellSeed' | 'anchor'>, cellAddr: string): string {
  return [
    `# /etc/opencell/oc-cell.conf, written by the OpenCell portal for node ${node.id} (${node.siteName})`,
    `cell_id = ${node.cellId}`,
    `core = ${cellAddr}`,
    'radio = board',
    'board = @BOARD@',
    `board_role = ${node.boardRole}`,
    'board_reset = 1',
    `cell_seed = 0x${node.cellSeed.toString(16).padStart(8, '0')}`,
    'tier = edge',
    'dl_band = 915',
    'ul_band = 915',
    'mode = part15',
    `sync_ch = ${node.anchor}`,
    'cert = /etc/opencell/cell.crt',
    'key = /etc/opencell/cell.key',
    'ca = /etc/opencell/ca.crt',
    '',
  ].join('\n');
}

const nl = (pem: string) => (pem.endsWith('\n') ? pem : `${pem}\n`);

/** The answer to a CSR: three parts by name. The cell's `cert` file is the chain: leaf, then the intermediate. */
export function bundleText(parts: { cert: string; chain: string; ca: string; conf: string }): string {
  return `--- oc-cell.crt\n${nl(parts.cert)}${nl(parts.chain)}--- ca.crt\n${nl(parts.ca)}--- oc-cell.conf\n${nl(parts.conf)}`;
}

export type IssueOutcome = { status: 200 | 400 | 404 | 410 | 429 | 503; body: string };

/** The intermediate, or null: not configured, or not fit to sign (decision 28). A bad one is logged; the operator is told only to wait. */
function usableCa(ctx: Ctx): CellCa | null {
  try {
    return loadCellCa(ctx);
  } catch (e) {
    console.error(`oc-portal: ${(e as Error).message}`);
    return null;
  }
}

/** The OpenCell root's PEM for a new cell's `ca`. */
function rootPem(ctx: Ctx): string | null {
  if (!ctx.config.coreCa) return null;
  try {
    return readFileSync(credentialPath(ctx.config.coreCa), 'utf8');
  } catch {
    return null;
  }
}

/**
 * A CSR with a setup token (spec §6.3 step 3, decision 11): the token is claimed
 * atomically, the CSR checked and signed, the leaf pinned with cell.set_cert,
 * and only then is the token spent. Any failure gives the claim back, so the
 * operator can run the command again; a certificate that was signed and could
 * not be pinned is useless at the core, and stays on record as such.
 */
export async function issueForToken(ctx: Ctx, token: string, csrPem: string, meta: { ip: string }): Promise<IssueOutcome> {
  if (ctx.config.site !== 'portal' || !TOKEN_RE.test(token)) return REFUSED.unknown;
  const lim = hitIp(ctx, 'setup_ip', meta.ip);
  if (!lim.ok) return { status: 429, body: `${lim.message}\n` };
  const ca = usableCa(ctx);
  const root = rootPem(ctx);
  if (!ca || !root) return { status: 503, body: NO_CERTS };
  const claim = claimToken(ctx, token);
  if (!claim.ok) return REFUSED[claim.why];
  const { node, tokenId } = claim;
  const check = await checkCsr(csrPem);
  if (!check.ok) {
    releaseClaim(ctx, tokenId);
    return { status: 400, body: `${check.why}\n` };
  }
  const handle = ctx.cores.find((h) => h.id === node.coreId);
  if (!handle?.cellAddr) {
    releaseClaim(ctx, tokenId);
    return { status: 503, body: NO_ANSWER };
  }
  let signed: SignedCell;
  try {
    signed = await signCellCert(ca, csrPem, node.certCn);
  } catch (e) {
    console.error(`oc-portal: signing a cell certificate for node ${node.id} failed (${errorKind(e)})`);
    releaseClaim(ctx, tokenId);
    return { status: 503, body: NO_CERTS };
  }
  const now = ctx.now();
  ctx.db.insert(issuedCerts).values({ nodeId: node.id, serial: signed.serial, fpr: signed.fpr, cn: node.certCn, notBefore: signed.notBefore, notAfter: signed.notAfter, pem: signed.pem, pinned: false, issuedAt: now }).run();
  const actor = coreActor(ctx.config.site, node.userId ?? 0);
  const pinned = await tryWithin(handle, 'cell.set_cert', () => handle.core.cellSetCert(actor, node.cellId, signed.fpr), WRITE_MS);
  if (!pinned.ok) {
    releaseClaim(ctx, tokenId);
    writeAudit(ctx, { actorId: node.userId, action: 'node.cert_unpinned', target: `node:${node.id}`, detail: { fpr: signed.fpr, serial: signed.serial }, ip: meta.ip });
    return { status: 503, body: NO_ANSWER };
  }
  ctx.db.transaction(() => {
    ctx.db.update(issuedCerts).set({ pinned: true }).where(eq(issuedCerts.fpr, signed.fpr)).run();
    ctx.db.update(nodes).set({ certFpr: signed.fpr, certIssuedAt: now, certExpiresAt: signed.notAfter }).where(eq(nodes.id, node.id)).run();
    ctx.db.update(nodeState).set({ online: null, onlineSince: null, offlineSince: null, offlineAlertAt: null, checkedAt: now }).where(eq(nodeState.nodeId, node.id)).run();
    writeAudit(ctx, { actorId: node.userId, action: 'node.cert', target: `node:${node.id}`, detail: { fpr: signed.fpr, serial: signed.serial }, ip: meta.ip });
  });
  const u = node.userId === null ? undefined : getUser(ctx, node.userId);
  if (u) {
    const m = nodeCertMail(u.name, node.siteName, signed.notAfter, `${ctx.config.origin}/nodes/${node.id}`, ctx.config.origin);
    ctx.mailQueue.send({ to: u.email, subject: m.subject, text: m.text });
  }
  return { status: 200, body: bundleText({ cert: signed.pem, chain: ca.certPem, ca: root, conf: cellConf(node, handle.cellAddr) }) };
}

/** Not a server action, and not a browser with its session: the CSR route is for the script (decision 13). */
const hasActionHeader = (req: Request) => req.headers.has('next-action');

function hasSessionCookie(ctx: Ctx, req: Request): boolean {
  const name = ctx.config.sessionCookie;
  return (req.headers.get('cookie') ?? '').split(';').some((c) => c.trim().startsWith(`${name}=`));
}

/** The token on the GETs: nothing is consumed, and what is wrong with it is one line of text. */
function checkGet(ctx: Ctx, token: string): Response | null {
  if (ctx.config.site !== 'portal') return text(REFUSED.unknown.status, REFUSED.unknown.body);
  const peek = peekToken(ctx, token);
  return peek.ok ? null : text(REFUSED[peek.why].status, REFUSED[peek.why].body);
}

/** GET /setup/<token>: the script, as plain text: `curl … | sudo bash`, or read it in a browser first (decision 14). */
export async function handleScript(ctx: Ctx, token: string, req: Request): Promise<Response> {
  if (hasActionHeader(req)) return text(400, 'This address takes no server actions.\n');
  const refused = checkGet(ctx, token);
  if (refused) return refused;
  const rel = currentRelease(ctx);
  if (!rel) return text(503, NO_RELEASE);
  if (!usableCa(ctx) || !rootPem(ctx)) return text(503, NO_CERTS);
  return text(200, renderSetupScript(ctx, token, rel));
}

/** GET /setup/<token>/oc-cell.tgz: the published source. */
export async function handleTarball(ctx: Ctx, token: string, req: Request): Promise<Response> {
  if (hasActionHeader(req)) return text(400, 'This address takes no server actions.\n');
  const refused = checkGet(ctx, token);
  if (refused) return refused;
  const rel = currentRelease(ctx);
  if (!rel) return text(503, NO_RELEASE);
  return new Response(Readable.toWeb(createReadStream(rel.path)) as ReadableStream, {
    status: 200,
    headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(rel.bytes), 'Cache-Control': 'no-store' },
  });
}

/** The body as text, or null past `max` bytes: it stops reading there. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** POST /setup/<token>/csr. */
export async function handleCsr(ctx: Ctx, token: string, req: Request): Promise<Response> {
  if (hasActionHeader(req) || hasSessionCookie(ctx, req)) return text(400, 'This address is for the setup script.\n');
  const body = await readCapped(req, CSR_MAX_BYTES);
  if (body === null) return text(400, `A CSR is at most ${CSR_MAX_BYTES} bytes.\n`);
  const r = await issueForToken(ctx, token, body, { ip: req.headers.get('x-oc-client-ip') ?? 'unknown' });
  return text(r.status, r.body);
}

