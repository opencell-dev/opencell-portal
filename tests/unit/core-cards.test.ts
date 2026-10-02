import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoreCards } from '@/components/core-cards';
import type { CoreStatus } from '@/core/types';

const core1: CoreStatus = {
  coreId: 1,
  name: 'oc-core-1',
  version: 'v0.2.0',
  uptimeS: 60,
  cellsTotal: 1,
  cellsOnline: 1,
  subscribers: 2,
  callsNow: 0,
};
const core2: CoreStatus = { ...core1, coreId: 2, name: 'oc-core-2', cellsTotal: 0, cellsOnline: 0, subscribers: 0 };

describe('the Cores section of the admin dashboard', () => {
  it("shows each core's name, version, cells and subscribers, and which core takes the numbers", () => {
    const html = renderToStaticMarkup(
      createElement(CoreCards, {
        rows: [
          { id: 'core1', where: '10.0.0.60:7444', status: core1 },
          { id: 'core2', where: '10.99.0.2:7444', status: core2 },
        ],
      }),
    );
    for (const t of ['core1', '10.0.0.60:7444', 'oc-core-1', 'v0.2.0', '1 / 1', 'core2', '10.99.0.2:7444', 'oc-core-2', '0 / 0']) {
      expect(html).toContain(t);
    }
    expect(html).toContain('Numbers and subscribers are handled by core1');
    expect(html).not.toContain('Unreachable');
  });

  it('shows an unreachable core as such, beside the others', () => {
    const html = renderToStaticMarkup(
      createElement(CoreCards, {
        rows: [
          { id: 'core1', where: '10.0.0.60:7444', status: core1 },
          { id: 'core2', where: '10.99.0.2:7444', status: null },
        ],
      }),
    );
    expect(html).toContain('oc-core-1');
    expect(html).toMatch(/core2.*Unreachable/s);
    expect(html).not.toContain('oc-core-2');
  });
});
