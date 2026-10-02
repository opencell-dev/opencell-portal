import { describe, expect, it, vi } from 'vitest';
import { CoreError } from '@/core/types';
import { REG_LIST_MAX } from '@/core/wire-noc';
import { listAudit } from '@/lib/audit';
import { registrationsPage } from '@/lib/noc/registrations';
import { testCtx } from '../helpers/ctx';

// reg.list read by a staff member (plan N2a): under their own account (the
// NOC site's offset), audited in the portal, paged by number.

describe('registrationsPage', () => {
  it("reads one cell's terminals as the staff member and audits it as noc.cell.terminals", async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    const id = ctx.core.simAddCell('A', 'part15', 1);
    ctx.core.simSubscriber('+883171746412345', 0x76ad0488, id);
    const spy = vi.spyOn(ctx.core, 'regList');
    const p = await registrationsPage(ctx, { core: 'fake', cellId: id }, 42, '192.0.2.7');
    expect(spy).toHaveBeenCalledWith(1_000_042, { cellId: id, after: undefined });
    expect(p).toMatchObject({ more: false, rows: { state: 'ok', value: [{ number: '+883171746412345' }] } });
    expect(listAudit(ctx, 1)[0]).toMatchObject({
      actorId: 42,
      action: 'noc.cell.terminals',
      target: `cell:fake/${id}`,
      detail: JSON.stringify({ core: 'fake', cell: id, after: null, rows: 1 }),
      ip: '192.0.2.7',
    });
  });

  it('pages a whole core by number, and says when there may be more', async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    const id = ctx.core.simAddCell('A', 'part15', 1);
    for (let i = 0; i < REG_LIST_MAX + 3; i++) ctx.core.simSubscriber(`+8831717464${String(10000 + i)}`, i + 1, id);
    const first = await registrationsPage(ctx, { core: 'fake' }, 42, 'ip');
    expect(first.more).toBe(true);
    if (first.rows.state !== 'ok') throw new Error('no rows');
    const next = await registrationsPage(ctx, { core: 'fake', after: first.rows.value.at(-1)!.number }, 42, 'ip');
    expect(next).toMatchObject({ more: false, rows: { state: 'ok', value: [{}, {}, {}] } });
    expect(listAudit(ctx, 1)[0]).toMatchObject({ action: 'noc.registrations', target: 'core:fake' });
  });

  it('says when the core is too old or does not answer, and audits that too', async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    vi.spyOn(ctx.core, 'regList').mockRejectedValueOnce(new CoreError('unsupported'));
    expect((await registrationsPage(ctx, { core: 'fake' }, 42, 'ip')).rows).toEqual({ state: 'unsupported' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ctx.core, 'regList').mockRejectedValueOnce(new CoreError('unavailable'));
    expect((await registrationsPage(ctx, { core: 'fake' }, 42, 'ip')).rows).toEqual({ state: 'unreachable' });
    expect((await registrationsPage(ctx, { core: 'nope' }, 42, 'ip')).rows).toEqual({ state: 'unreachable' });
    expect(listAudit(ctx, 5).map((a) => JSON.parse(a.detail ?? '{}').rows)).toEqual(['unreachable', 'unsupported']);
  });
});
