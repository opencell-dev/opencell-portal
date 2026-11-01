import { connect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { FrameReader } from '@/core/wire';

// A cell on a real oc-core's cell socket (network-core §6, a Unix socket):
// HELLO, then CELL_STATUS (NOC design §7.3), as oc-cell sends them, so the
// tests can see cell.radio and reg.list carry what a cell reported.
// Frames: len (2, big-endian, counting type and body) | type (1) | body;
// fields little-endian (oc_core_msg.h).

const HELLO = 0x01;
const HELLO_ACK = 0x02;
const HELLO_NAK = 0x03;
const CELL_STATUS = 0x07;
const PROTO = 2;
const STATUS_VER = 1;
const STATUS_LAST = 0x80;

export interface CellRadioReport {
  radio: number;
  role: number;
  band: number;
  fw: [number, number, number];
  anchor: number;
  pps: number;
  timebase: number;
  tempC: number;
  uptimeS: number;
  schedules: number;
  rach: number;
  attach: number;
  grants: number;
  ackErr: number;
  ackLate: number;
  lateSlots: number;
  radioErrors: number;
  schedMisses: number;
  uartCrc: number;
  lastRadioErr: number;
}

export interface CellTermReport {
  tmid: number;
  rssiDbm: number;
  snrQdb: number;
  heardAgeS: number;
  ulRx: number;
}

class Bytes {
  readonly b: number[] = [];
  u8(v: number) {
    this.b.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number) {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
}

function frame(type: number, body: Bytes): Buffer {
  const len = body.b.length + 1;
  return Buffer.from([len >> 8, len & 0xff, type, ...body.b]);
}

export class FakeCell {
  private readonly frames = new FrameReader();
  private waiting: ((type: number) => void) | undefined;
  /** Resolves when the core closes the link. */
  readonly closed: Promise<void>;

  private constructor(private readonly sock: Socket) {
    this.closed = new Promise((resolve) => sock.once('close', () => resolve()));
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      for (const f of this.frames.push(chunk)) this.waiting?.(f[2]);
    });
  }

  /** Connects to `socketPath` as cell `cellId` and says HELLO; resolves on HELLO_ACK, rejects on HELLO_NAK. */
  static async hello(socketPath: string, cellId: number): Promise<FakeCell> {
    const sock = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
    return new FakeCell(sock).sayHello(cellId);
  }

  /**
   * The same over TLS, as oc-cell dials `core = HOST:PORT` (network-core §17):
   * ALPN oc-cell/1, its certificate file (leaf + intermediate) and key. Rejects
   * when the core refuses: at the handshake ("TLS …"), or at HELLO. In TLS 1.3 a
   * client certificate is judged after the client's side of the handshake ends,
   * so a refusal shows up as the link closing before the answer.
   */
  static async helloTls(opts: { host: string; port: number; servername: string; ca: string; cert: string; key: string }, cellId: number): Promise<FakeCell> {
    const sock: TLSSocket = tlsConnect({ host: opts.host, port: opts.port, servername: opts.servername, ca: opts.ca, cert: opts.cert, key: opts.key, ALPNProtocols: ['oc-cell/1'], minVersion: 'TLSv1.3' });
    await new Promise<void>((resolve, reject) => {
      sock.once('secureConnect', () => resolve());
      sock.once('error', (e) => reject(new Error(`TLS: ${e.message}`)));
    });
    return new FakeCell(sock).sayHello(cellId);
  }

  private async sayHello(cellId: number): Promise<FakeCell> {
    const answer = new Promise<number>((resolve) => {
      this.waiting = (t) => {
        if (t === HELLO_ACK || t === HELLO_NAK) resolve(t);
      };
    });
    const gone = this.closed.then(() => 'closed' as const);
    const body = new Bytes().u8(PROTO).u32(cellId).u32(1).u32(0).u8(0).u8(1).u8(2);
    this.sock.write(frame(HELLO, body));
    const got = await Promise.race([answer, gone]);
    if (got === 'closed') throw new Error(`cell ${cellId}: the core closed the link`);
    if (got !== HELLO_ACK) {
      this.sock.destroy();
      throw new Error(`cell ${cellId}: HELLO refused`);
    }
    this.waiting = undefined;
    return this;
  }

  /** One whole CELL_STATUS (a single, last part). */
  report(radios: CellRadioReport[], terms: CellTermReport[]): void {
    const b = new Bytes().u8(STATUS_VER).u8(STATUS_LAST).u8(radios.length);
    for (const x of radios) {
      b.u8(x.radio).u8(x.role).u8(x.band).u8(x.fw[0]).u8(x.fw[1]).u8(x.fw[2]).u8(x.anchor).u8(x.pps).u8(x.timebase).u8(x.tempC);
      b.u32(x.uptimeS).u32(x.schedules).u32(x.rach).u32(x.attach).u32(x.grants).u32(x.ackErr).u32(x.ackLate);
      b.u16(x.lateSlots).u16(x.radioErrors).u16(x.schedMisses).u16(x.uartCrc).u16(x.lastRadioErr);
    }
    b.u8(terms.length);
    for (const t of terms) b.u32(t.tmid).u16(t.rssiDbm).u16(t.snrQdb).u16(t.heardAgeS).u32(t.ulRx);
    this.sock.write(frame(CELL_STATUS, b));
  }

  close(): void {
    this.sock.destroy();
  }
}
