import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { credentialPath, TlsCore } from '@/core/tls-client';
import { CoreError } from '@/core/types';
import { FrameReader, OP, Reader, Writer } from '@/core/wire';
import { makeTestPki, type TestPki } from '../helpers/test-pki';

// TlsCore against a scripted core: a Node TLS server that reads request
// frames and answers as `answer` says (a list of frames, or nothing).

interface Req {
  op: number;
  req: number;
  actor: number;
  body: Uint8Array;
}

type Script = (r: Req, sock: tls.TLSSocket) => Uint8Array[] | undefined;

function frame(op: number, req: number, status: number, body: (w: Writer) => void = () => {}): Uint8Array {
  const w = new Writer().u16(0).u8(0x80 | op).u32(req).u8(status);
  body(w);
  const f = w.toBytes();
  f[0] = (f.length - 2) >> 8;
  f[1] = (f.length - 2) & 0xff;
  return f;
}

let pki: TestPki;
let server: tls.Server | undefined;
let clients: TlsCore[] = [];
let connections = 0;

beforeAll(() => {
  pki = makeTestPki();
});
afterAll(() => rmSync(pki.dir, { recursive: true, force: true }));
afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** opts.alpn: the protocols the core offers (default oc-admin/1); null: none at all. */
async function serve(script: Script, opts: { cert?: string; alpn?: string[] | null } = {}): Promise<number> {
  connections = 0;
  server = tls.createServer(
    {
      key: pki.read(`${opts.cert ?? 'server'}.key`),
      cert: pki.read(`${opts.cert ?? 'server'}.crt`),
      ca: pki.read('ca.crt'),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      ...(opts.alpn === null ? {} : { ALPNProtocols: opts.alpn ?? ['oc-admin/1'] }),
    },
    (sock) => {
      connections++;
      const frames = new FrameReader();
      sock.on('error', () => {});
      sock.on('data', (chunk: Buffer) => {
        for (const f of frames.push(chunk)) {
          const r = new Reader(f.subarray(2));
          const req: Req = { op: r.u8(), req: r.u32(), actor: r.u32(), body: f.subarray(11) };
          for (const a of script(req, sock) ?? []) sock.write(a);
        }
      });
    },
  );
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return (server!.address() as AddressInfo).port;
}

function client(port: number, timeoutMs = 2000): TlsCore {
  const c = new TlsCore({
    host: '127.0.0.1',
    port,
    servername: 'localhost',
    ca: pki.path('ca.crt'),
    cert: pki.path('client.crt'),
    key: pki.path('client.key'),
    timeoutMs,
  });
  clients.push(c);
  return c;
}

describe('TlsCore', () => {
  it('asks for the core status and reads the answer', async () => {
    let seen: Req | undefined;
    const port = await serve((r) => {
      seen = r;
      return [
        frame(r.op, r.req, 0, (w) => w.u16(1).u32(3600).u32(2).u32(1).u32(7).u16(0).text('oc-core-1').text('v0.2.0')),
      ];
    });
    const st = await client(port).coreStatus(5);
    expect(seen).toMatchObject({ op: OP.coreStatus, actor: 5 });
    expect(st).toEqual({
      coreId: 1,
      name: 'oc-core-1',
      version: 'v0.2.0',
      uptimeS: 3600,
      cellsTotal: 2,
      cellsOnline: 1,
      subscribers: 7,
      callsNow: 0,
    });
  });

  it('reads a subscriber status', async () => {
    const port = await serve((r) => [
      frame(r.op, r.req, 0, (w) =>
        w.raw(r.body.subarray(0, 8)).u8(1).u8(0).u32(0).u8(1).u32(3).u16(0x76ad).u32(1_790_000_100),
      ),
    ]);
    expect(await client(port).subStatus(1, '+883171746412345')).toEqual({
      number: '+883171746412345',
      state: 'activated',
      disabled: false,
      tokenExpiresAt: null,
      registered: true,
      cellId: 3,
      tmidPrefix: '76ad',
      lastSeenAt: 1_790_000_100_000,
    });
  });

  it('puts a long list back together from its frames', async () => {
    const row = (w: Writer, setup: number) => w.u32(setup).u32(setup + 2).u32(setup + 32).u8(0).u8(1).number('+883171746400777');
    const port = await serve((r) => [
      frame(r.op, r.req, 1, (w) => row(row(w.u8(2), 300), 200)),
      frame(r.op, r.req, 0, (w) => row(w.u8(1), 100)),
    ]);
    const cdrs = await client(port).cdrList(1, '+883171746412345', 0);
    expect(cdrs.map((c) => c.at)).toEqual([300_000, 200_000, 100_000]);
    expect(cdrs[0]).toEqual({
      at: 300_000,
      number: '+883171746412345',
      peer: '+883171746400777',
      direction: 'in',
      durationS: 30,
      result: 'answered',
    });
  });

  it('turns the core refusing into a CoreError', async () => {
    const port = await serve((r) => [frame(r.op, r.req, 0x12, (w) => w.text('refused'))]);
    await expect(client(port).subCreate(1, '+883171746412345')).rejects.toMatchObject({ code: 'taken' });
  });

  it('refuses a bad number or fingerprint without asking the core', async () => {
    const port = await serve(() => undefined);
    const c = client(port);
    await expect(c.subCreate(1, 'garbage')).rejects.toMatchObject({ code: 'invalid' });
    expect(await c.numCheck(1, 'garbage')).toBe('not_assignable');
    await expect(c.cellSetCert(1, 2, 'ABCD')).rejects.toMatchObject({ code: 'invalid' });
    expect(connections).toBe(0);
  });

  it('matches answers to calls by their request id', async () => {
    const held: Req[] = [];
    const port = await serve((r, sock) => {
      held.push(r);
      if (held.length < 2) return undefined;
      for (const h of [...held].reverse()) sock.write(frame(h.op, h.req, 0, (w) => w.u8(h.actor === 1 ? 0 : 1)));
      return undefined;
    });
    const c = client(port);
    const [a, b] = await Promise.all([c.numCheck(1, '+883171746412345'), c.numCheck(2, '+883171746412346')]);
    expect([a, b]).toEqual(['free', 'taken']);
    expect(connections).toBe(1);
  });

  it('gives up on a core that does not answer, then connects again', async () => {
    let calls = 0;
    const port = await serve((r) => (++calls === 1 ? undefined : [frame(r.op, r.req, 0, (w) => w.u8(0))]));
    const c = client(port, 300);
    const t0 = Date.now();
    await expect(c.numCheck(1, '+883171746412345')).rejects.toMatchObject({ code: 'unavailable' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await c.numCheck(1, '+883171746412345')).toBe('free');
    expect(connections).toBe(2);
  });

  it('fails the calls in flight when the core closes, then connects again', async () => {
    let calls = 0;
    const port = await serve((r, sock) => {
      if (++calls === 1) {
        sock.destroy();
        return undefined;
      }
      return [frame(r.op, r.req, 0, (w) => w.u8(1))];
    });
    const c = client(port);
    await expect(c.numCheck(1, '+883171746412345')).rejects.toBeInstanceOf(CoreError);
    expect(await c.numCheck(1, '+883171746412345')).toBe('taken');
  });

  // The cores below answer every call: a TlsCore that let one of them
  // through would get an answer, so each refusal is TlsCore's own, made at
  // the handshake (no request reaches the core), and says why.
  async function refusedBy(opts: { cert?: string; alpn?: string[] | null }, why: RegExp) {
    let served = 0;
    const port = await serve(
      (r) => {
        served++;
        return [frame(r.op, r.req, 0, (w) => w.u16(1).u32(0).u32(0).u32(0).u32(0).u16(0).text('x').text('v'))];
      },
      opts,
    );
    const t0 = Date.now();
    const err = await client(port, 3000).coreStatus(1).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CoreError);
    expect(err).toMatchObject({ code: 'unavailable' });
    expect((err as Error).message).toMatch(why);
    expect(Date.now() - t0).toBeLessThan(1000); // at the handshake, not at the call's timeout
    expect(served).toBe(0);
  }

  it('refuses a core whose certificate is not from the OpenCell root', async () => {
    await refusedBy({ cert: 'rogue-server' }, /unable to verify/i);
  });

  it('refuses a core whose certificate is for another name', async () => {
    await refusedBy({ cert: 'wrong-name' }, /does not match|altnames/i);
  });

  it('refuses a core that does not speak oc-admin/1', async () => {
    await refusedBy({ alpn: null }, /does not speak oc-admin\/1/);
  });

  it('refuses a core that offers only another protocol', async () => {
    await refusedBy({ alpn: ['oc-cell/1'] }, /alert|protocol/i);
  });

  it('says so when its files are missing', async () => {
    const c = new TlsCore({ host: '127.0.0.1', port: 1, servername: 'x', ca: '/nonexistent/ca.crt', cert: 'c', key: 'k' });
    await expect(c.coreStatus(1)).rejects.toThrow(/TLS files can't be read/);
  });
});

describe('credentialPath', () => {
  it('reads a bare name from the systemd credentials, a path as it is', () => {
    expect(credentialPath('portal.key', { CREDENTIALS_DIRECTORY: '/run/credentials/oc-portal.service' })).toBe(
      '/run/credentials/oc-portal.service/portal.key',
    );
    expect(credentialPath('/etc/opencell/tls/ca.crt', { CREDENTIALS_DIRECTORY: '/run/c' })).toBe('/etc/opencell/tls/ca.crt');
    expect(credentialPath('portal.key', {})).toBe('portal.key');
  });
});
