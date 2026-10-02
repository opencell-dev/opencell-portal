import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FakeCore } from '@/core/fake';
import { coreContract } from '../helpers/core-contract';
import { CORE_DIR, startRealCore } from '../helpers/real-core';

// The same contract for the fake core (always) and a real oc-core over TLS
// (when OC_CORE_DIR names a built opencell-core checkout).
coreContract('fake core', async () => ({ core: new FakeCore(), done: async () => {} }));

describe.skipIf(!CORE_DIR)('against a real oc-core', () => {
  coreContract('oc-core over TLS', () => startRealCore());

  it('audits each call with the portal account it was for', async () => {
    const c = await startRealCore();
    try {
      await c.core.subCreate(4242, '+883171746477777');
      const out = execFileSync(`${CORE_DIR}/build/oc/oc-core`, ['admin', '--socket', c.adminSocket, 'audit', '3']);
      expect(out.toString()).toContain('a4242 sub.create ok');
    } finally {
      await c.done();
    }
  });

  it('done() does not hang on a process that already died by a signal (review M5)', async () => {
    const c = await startRealCore();
    process.kill(c.pid, 'SIGKILL');
    // Give the OS time to reap it, so the ChildProcess's own 'exit' event has
    // already fired by the time done() looks — the scenario a clean SIGTERM
    // exit (exitCode set) never hits, since only signalCode gets set here.
    await new Promise((r) => setTimeout(r, 300));
    await c.done();
    await c.done(); // idempotent: must not hang waiting on a stale 'exit' listener
  }, 10_000);
});
