import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { nodes, setupTokens, users } from '@/db/schema';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { hashToken, newToken } from '@/lib/tokens';

// The one-time setup token (portal spec §6.2; plan P3, decisions 10, 11): 24 h,
// single use, consumed by the CSR that gets a certificate. Only its hash is
// stored, so it is shown once: in the approval mail, or on the page after
// "Make a new setup command".

export const SETUP_TOKEN_MS = 24 * 3600_000;
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const MAX_CSR_TRIES = 5;

export type Node = typeof nodes.$inferSelect;
export type TokenRefusal = 'unknown' | 'expired' | 'used' | 'revoked' | 'tries';
export type TokenPeek = { ok: true; tokenId: string; node: Node } | { ok: false; why: TokenRefusal };

/** The command an operator runs on the Pi, exactly (spec §6.3). */
export function setupCommand(ctx: Ctx, token: string): string {
  return `curl -fsSL ${ctx.config.origin}/setup/${token} | sudo bash`;
}

/** The same with a new key on the Pi: a new certificate, which re-pins the cell (decision 10). */
export function newKeyCommand(ctx: Ctx, token: string): string {
  return `${setupCommand(ctx, token)} -s -- --new-key`;
}

/**
 * A new token for a node; the node's earlier ones stop working. They also
 * expire now, so a CSR still running on one cannot bring it back by giving up
 * its claim (releaseClaim).
 */
export function makeSetupToken(ctx: Ctx, nodeId: number, byUserId: number | null): { token: string; expiresAt: number } {
  const token = newToken();
  const now = ctx.now();
  const expiresAt = now + SETUP_TOKEN_MS;
  ctx.db.transaction(() => {
    const voided = ctx.db
      .update(setupTokens)
      .set({ usedAt: sql`coalesce(${setupTokens.usedAt}, ${now})`, expiresAt: sql`min(${setupTokens.expiresAt}, ${now})` })
      .where(and(eq(setupTokens.nodeId, nodeId), gt(setupTokens.expiresAt, now)))
      .run();
    if (voided.changes > 0) writeAudit(ctx, { actorId: byUserId, action: 'setup.void', target: `node:${nodeId}`, detail: { tokens: voided.changes } });
    ctx.db.insert(setupTokens).values({ id: hashToken(token), nodeId, createdAt: now, expiresAt }).run();
    writeAudit(ctx, { actorId: byUserId, action: 'setup.token', target: `node:${nodeId}` });
  });
  return { token, expiresAt };
}

function look(ctx: Ctx, token: string): TokenPeek {
  if (!TOKEN_RE.test(token)) return { ok: false, why: 'unknown' };
  const id = hashToken(token);
  const row = ctx.db.select().from(setupTokens).innerJoin(nodes, eq(nodes.id, setupTokens.nodeId)).leftJoin(users, eq(users.id, nodes.userId)).where(eq(setupTokens.id, id)).get();
  if (!row) return { ok: false, why: 'unknown' };
  if (row.nodes.revokedAt !== null) return { ok: false, why: 'revoked' };
  // No operator, or a disabled one: a certificate would re-pin a live cell for someone with no account here.
  if (!row.users || row.users.disabledAt !== null) return { ok: false, why: 'revoked' };
  if (row.setup_tokens.usedAt !== null) return { ok: false, why: 'used' };
  if (row.setup_tokens.expiresAt <= ctx.now()) return { ok: false, why: 'expired' };
  if (row.setup_tokens.csrTries >= MAX_CSR_TRIES) return { ok: false, why: 'tries' };
  return { ok: true, tokenId: id, node: row.nodes };
}

/** What the script and tarball GETs check: nothing is consumed. */
export function peekToken(ctx: Ctx, token: string): TokenPeek {
  return look(ctx, token);
}

/** Take the token for one CSR, atomically (decision 11): one of any number of simultaneous posts wins. */
export function claimToken(ctx: Ctx, token: string): TokenPeek {
  const seen = look(ctx, token);
  if (!seen.ok) return seen;
  const now = ctx.now();
  const claimed = ctx.db
    .update(setupTokens)
    .set({ usedAt: now, csrTries: sql`${setupTokens.csrTries} + 1` })
    .where(and(eq(setupTokens.id, seen.tokenId), isNull(setupTokens.usedAt), gt(setupTokens.expiresAt, now), lt(setupTokens.csrTries, MAX_CSR_TRIES)))
    .run();
  return claimed.changes === 1 ? seen : look(ctx, token);
}

/** Every setup token of an account's nodes stops working: the account is being disabled, and enabling it must not bring them back. */
export function voidTokensOfUser(ctx: Ctx, userId: number): void {
  const now = ctx.now();
  for (const n of ctx.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.userId, userId)).all()) {
    ctx.db.update(setupTokens).set({ usedAt: sql`coalesce(${setupTokens.usedAt}, ${now})`, expiresAt: sql`min(${setupTokens.expiresAt}, ${now})` }).where(and(eq(setupTokens.nodeId, n.id), gt(setupTokens.expiresAt, now))).run();
  }
}

/** Signing or pinning failed: the operator can run the command again. */
export function releaseClaim(ctx: Ctx, tokenId: string): void {
  ctx.db.update(setupTokens).set({ usedAt: null }).where(eq(setupTokens.id, tokenId)).run();
}
