import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreError } from '@/core/types';
import { cachedActivity } from '@/lib/noc/activity';
import { getCall, listCalls, parseCallFilter } from '@/lib/noc/calls';
import { coreAuditView } from '@/lib/noc/core-audit';
import { registrationsPage } from '@/lib/noc/registrations';
import { cachedSnapshot, forgetSnapshot } from '@/lib/noc/snapshot';
import { testCtx } from '../helpers/ctx';

// Review final (v0.5.0-rc.1), I4: an older core's missing operations are
// memoized per (core, operation) on the per-viewer reads too, not only on
// the shared polls; a rate-limited op backs off instead of being asked
// again on every snapshot; and every view says "needs oc-core v0.4.0" the
// same way once the shared activity already knows the op is unsupported.

afterEach(() => vi.restoreAllMocks());

describe("an older core, seen by a view-heavy session (review I4)", () => {
  it("remembers reg.list is unsupported per core, so a viewer's repeated reads do not keep asking it", async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    const regList = vi.spyOn(ctx.core, 'regList').mockRejectedValue(new CoreError('unsupported'));
    const a = await registrationsPage(ctx, { core: 'fake' }, 42, 'ip');
    const b = await registrationsPage(ctx, { core: 'fake' }, 43, 'ip');
    expect(a.rows).toEqual({ state: 'unsupported' });
    expect(b.rows).toEqual({ state: 'unsupported' });
    expect(regList).toHaveBeenCalledTimes(1);
  });

  it('labels the Calls page and a call "unsupported", not "not read yet" and not a red alert, once the shared activity knows cdr.recent is unsupported', async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    vi.spyOn(ctx.core, 'cdrRecent').mockRejectedValue(new CoreError('unsupported'));
    await cachedActivity(ctx, await cachedSnapshot(ctx));
    const list = await listCalls(ctx, parseCallFilter({}), 42, 'ip');
    expect(list.cores).toEqual([{ id: 'fake', state: 'unsupported', truncated: false }]);
    expect(await getCall(ctx, 'fake', 1, 42, 'ip')).toBe('unsupported');
  });

  it("labels the core's audit panel \"unsupported\" too, from the same per-(core, op) memo as the shared poll", async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    vi.spyOn(ctx.core, 'auditList').mockRejectedValue(new CoreError('unsupported'));
    await cachedActivity(ctx, await cachedSnapshot(ctx));
    expect((await coreAuditView(ctx, 'fake', 42, 'ip')).records).toEqual({ state: 'unsupported' });
  });

  it('backs off a rate-limited op instead of asking it again on every 10-second snapshot', async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    const radio = vi.spyOn(ctx.core, 'cellRadio').mockRejectedValueOnce(new CoreError('rate_limited'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await cachedSnapshot(ctx);
    expect(radio).toHaveBeenCalledTimes(1);
    forgetSnapshot(ctx);
    ctx.clock.t += 10_000; // the next poll, 10 s later: still inside the backoff
    await cachedSnapshot(ctx);
    expect(radio).toHaveBeenCalledTimes(1);
  });
});
