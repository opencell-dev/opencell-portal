import { describe, expect, it } from 'vitest';
import { afterChange, keepOnFailure } from '@/lib/noc/change-ui';

// Review final (v0.5.0-rc.1), M8: SubscriberControls re-reads the lookup
// after a successful change, to show its new state; that re-read must
// never be able to make the change itself look like it failed. Kept as
// small, framework-free functions so the control-flow bug is covered by a
// unit test without a rendered component or a DOM.

describe('afterChange', () => {
  it("runs the refresh, and lets it resolve normally", async () => {
    let ran = false;
    await afterChange(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('swallows a refresh that throws: the change it follows already succeeded', async () => {
    await expect(
      afterChange(async () => {
        throw new Error('the re-read failed');
      }),
    ).resolves.toBeUndefined();
  });
});

describe('keepOnFailure', () => {
  type Result = { ok: true; message: string } | { ok: false; message: string };
  const ok: Result = { ok: true, message: 'changed' };
  const refused: Result = { ok: false, message: 'Too many changes this hour. Please try again later.' };
  const okAgain: Result = { ok: true, message: 'still changed' };

  it('keeps the previous result when the next one is a failure, so a refused re-read does not hide what already succeeded', () => {
    expect(keepOnFailure<Result>(ok, refused)).toBe(ok);
  });

  it('takes the next result when it succeeds', () => {
    expect(keepOnFailure<Result>(ok, okAgain)).toBe(okAgain);
  });
});
