import { describe, expect, it, vi } from 'vitest';
import { type TestCtx, testCtx } from '../helpers/ctx';

// M1 (final review): the deploy script checks /healthz's site against the
// guest it meant to reach (OC_PORTAL_HOST), so a misconfigured guest (for
// example portal.env missing OC_SITE=noc) fails the health check instead of
// quietly going live as the wrong site.

let current: TestCtx = testCtx();
vi.mock('@/lib/ctx', () => ({ appCtx: () => current }));

const { GET } = await import('@/app/healthz/route');

describe('GET /healthz', () => {
  it('reports the site alongside ok and version', async () => {
    current = testCtx();
    const prev = process.env.OC_VERSION;
    process.env.OC_VERSION = 'v9.9.9';
    try {
      const body = await (GET() as Response).json();
      expect(body).toEqual({ ok: true, version: 'v9.9.9', site: 'portal' });
    } finally {
      if (prev === undefined) delete process.env.OC_VERSION;
      else process.env.OC_VERSION = prev;
    }
  });

  it("reports the NOC's site there", async () => {
    current = testCtx({ OC_SITE: 'noc' });
    const body = await (GET() as Response).json();
    expect(body.site).toBe('noc');
  });
});
