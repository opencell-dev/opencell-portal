import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkCaptcha, newChallenge } from '@/lib/captcha';
import { type TestCtx, testCtx } from '../helpers/ctx';

let ctx: TestCtx;
beforeEach(() => {
  ctx = testCtx();
});

/** What the widget puts in its hidden field: base64 of {challenge, solution}. */
async function solve(challenge: Awaited<ReturnType<typeof newChallenge>>) {
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error('unsolved');
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}

describe('ALTCHA proof of work (self-hosted)', () => {
  it('accepts a solved challenge once', async () => {
    const payload = await solve(await newChallenge(ctx));
    expect(await checkCaptcha(ctx, payload)).toBe(true);
    expect(await checkCaptcha(ctx, payload)).toBe(false); // replay
  });

  it('refuses a missing, malformed or tampered payload', async () => {
    expect(await checkCaptcha(ctx, '')).toBe(false);
    expect(await checkCaptcha(ctx, 'not base64 json')).toBe(false);
    const ch = await newChallenge(ctx);
    const payload = JSON.parse(Buffer.from(await solve(ch), 'base64').toString());
    payload.challenge.parameters.cost = 1;
    payload.challenge.parameters.nonce = 'ff'.repeat(16);
    expect(await checkCaptcha(ctx, Buffer.from(JSON.stringify(payload)).toString('base64'))).toBe(false);
  });

  it('refuses a solution to a challenge signed with another secret', async () => {
    const other = testCtx();
    other.config = { ...other.config, secret: 'another-secret-another-secret-another-0' };
    const payload = await solve(await newChallenge(other));
    expect(await checkCaptcha(ctx, payload)).toBe(false);
  });

  it('refuses an expired challenge', async () => {
    const payload = await solve(await newChallenge(ctx, -1000));
    expect(await checkCaptcha(ctx, payload)).toBe(false);
  });
});
