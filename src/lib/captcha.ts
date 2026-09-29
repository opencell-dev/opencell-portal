import { createHmac } from 'node:crypto';
import { createChallenge, randomInt, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { lt } from 'drizzle-orm';
import { z } from 'zod';
import { captchaUsed } from '@/db/schema';
import type { Ctx } from '@/lib/ctx';

// ALTCHA proof of work, self-hosted (portal spec §3): the portal issues
// HMAC-signed PBKDF2 challenges and checks solutions itself. altcha-lib
// checks expiry against the real clock (Date.now), so this module does too.

const ALGORITHM = 'PBKDF2/SHA-256';
const TTL_MS = 10 * 60_000;

function secrets(ctx: Ctx) {
  const sub = (label: string) => createHmac('sha256', ctx.config.secret).update(label).digest('hex');
  return { hmacSignatureSecret: sub('altcha-signature'), hmacKeySignatureSecret: sub('altcha-key') };
}

export async function newChallenge(ctx: Ctx, ttlMs = TTL_MS) {
  const { cost, counterMax } = ctx.config.altcha;
  return createChallenge({
    algorithm: ALGORITHM,
    cost,
    counter: randomInt(Math.ceil(counterMax / 2), counterMax),
    deriveKey,
    expiresAt: new Date(Date.now() + ttlMs),
    ...secrets(ctx),
  });
}

const payloadSchema = z.object({
  challenge: z.object({
    parameters: z
      .object({
        algorithm: z.literal(ALGORITHM),
        nonce: z.string().min(8).max(128),
        salt: z.string().min(8).max(128),
        cost: z.number().int(),
        keyLength: z.number().int(),
        keyPrefix: z.string().max(256),
      })
      .loose(),
    signature: z.string().max(256),
  }),
  solution: z.object({ counter: z.number().int().min(0), derivedKey: z.string().max(256), time: z.number().optional() }),
});

/** True once per solved, unexpired challenge this portal signed. */
export async function checkCaptcha(ctx: Ctx, payload: string): Promise<boolean> {
  if (!payload || payload.length > 4096) return false;
  let parsed: z.infer<typeof payloadSchema>;
  try {
    parsed = payloadSchema.parse(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')));
  } catch {
    return false;
  }
  const result = await verifySolution({
    challenge: parsed.challenge,
    solution: parsed.solution,
    deriveKey,
    ...secrets(ctx),
  });
  if (!result.verified) return false;
  const now = Date.now();
  const expiresAt = (parsed.challenge.parameters.expiresAt as number | undefined) ?? 0;
  ctx.db.delete(captchaUsed).where(lt(captchaUsed.expiresAt, now)).run();
  const inserted = ctx.db
    .insert(captchaUsed)
    .values({ id: parsed.challenge.parameters.nonce, expiresAt: expiresAt * 1000 || now + TTL_MS })
    .onConflictDoNothing()
    .run();
  return inserted.changes === 1;
}
