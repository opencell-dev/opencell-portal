import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { newChallenge } from '@/lib/captcha';
import type { Ctx } from '@/lib/ctx';

/** A solved ALTCHA payload, as the widget would submit it. */
export async function solvedCaptcha(ctx: Ctx): Promise<string> {
  const challenge = await newChallenge(ctx);
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error('unsolved');
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}
