import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs on Node 22', () => {
    expect(Number(process.versions.node.split('.')[0])).toBe(22);
  });
});
