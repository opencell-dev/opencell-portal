// The real core admin API (portal spec §7): TLS 1.3 to a core's port 7444,
// ALPN oc-admin/1, this portal's client certificate (the portal role, pinned
// in the core's config), the core's certificate checked against the
// OpenCell root for its name. One connection, opened on the first call and
// again after any failure; calls may overlap (each has its own req id),
// and the core answers them in order.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { isFullNumber } from './numbers';
import {
  type Cdr,
  type CellMode,
  type CellStatus,
  type CoreAdmin,
  CoreError,
  type CoreStatus,
  type IssuedToken,
  type NumCheck,
  type SubStatus,
} from './types';
import {
  type Answer,
  answerError,
  cdrResult,
  FrameReader,
  OP,
  parseAnswer,
  Reader,
  request,
  STATUS_MORE,
  STATUS_OK,
  type Writer,
} from './wire';

export const ALPN = 'oc-admin/1';

export interface TlsCoreOptions {
  host: string;
  port: number;
  /** The name the core's certificate carries (and SNI). */
  servername: string;
  /** Files: a path, or (no '/') a systemd credential's name. */
  ca: string;
  cert: string;
  key: string;
  /** Per call, and for connecting. Default 5 s. */
  timeoutMs?: number;
}

/** A path as configured, or a credential in $CREDENTIALS_DIRECTORY. */
export function credentialPath(v: string, env: Record<string, string | undefined> = process.env): string {
  const dir = env.CREDENTIALS_DIRECTORY;
  return v.includes('/') || !dir ? v : join(dir, v);
}

interface Pending {
  frames: Answer[];
  resolve: (a: Answer[]) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const FPR = /^[0-9a-f]{64}$/;
const MODE: Record<CellMode, number> = { part15: 1, part97: 2 };

export class TlsCore implements CoreAdmin {
  private sock: tls.TLSSocket | undefined;
  private connecting: Promise<tls.TLSSocket> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextReq = 1;
  private readonly timeoutMs: number;

  constructor(private readonly opts: TlsCoreOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  /** Closes the connection; calls in flight fail with 'unavailable'. */
  close(): void {
    this.sock?.destroy();
    this.drop(new CoreError('unavailable', 'closed'));
  }

  private drop(e: Error) {
    this.sock = undefined;
    for (const [req, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(req);
      p.reject(e);
    }
  }

  private connect(): Promise<tls.TLSSocket> {
    if (this.sock) return Promise.resolve(this.sock);
    this.connecting ??= new Promise<tls.TLSSocket>((resolve, reject) => {
      let files: { ca: Buffer; cert: Buffer; key: Buffer };
      try {
        files = {
          ca: readFileSync(credentialPath(this.opts.ca)),
          cert: readFileSync(credentialPath(this.opts.cert)),
          key: readFileSync(credentialPath(this.opts.key)),
        };
      } catch (e) {
        reject(new CoreError('unavailable', `the core's TLS files can't be read: ${(e as Error).message}`));
        return;
      }
      const s = tls.connect({
        host: this.opts.host,
        port: this.opts.port,
        servername: this.opts.servername,
        ...files,
        ALPNProtocols: [ALPN],
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        timeout: this.timeoutMs,
      });
      const frames = new FrameReader();
      const fail = (e: Error) => {
        s.destroy();
        reject(e instanceof CoreError ? e : new CoreError('unavailable', e.message));
      };
      s.once('timeout', () => fail(new CoreError('unavailable', 'the core did not answer in time')));
      s.once('error', fail);
      s.once('secureConnect', () => {
        if (s.alpnProtocol !== ALPN) {
          fail(new CoreError('unavailable', `the core does not speak ${ALPN}`));
          return;
        }
        s.setTimeout(0);
        s.removeListener('error', fail);
        s.on('error', () => {}); // 'close' follows, and drops the calls in flight
        s.on('close', () => {
          if (this.sock === s) this.drop(new CoreError('unavailable', 'the core closed the connection'));
        });
        s.on('data', (chunk: Buffer) => {
          try {
            for (const f of frames.push(chunk)) this.onFrame(parseAnswer(f));
          } catch (e) {
            s.destroy();
            this.drop(e as Error);
          }
        });
        this.sock = s;
        resolve(s);
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private onFrame(a: Answer) {
    const p = this.pending.get(a.req);
    if (!p) throw new CoreError('unavailable', `an answer to no call (req ${a.req})`);
    p.frames.push(a);
    if (a.status === STATUS_MORE) return;
    clearTimeout(p.timer);
    this.pending.delete(a.req);
    if (a.status === STATUS_OK) p.resolve(p.frames);
    else p.reject(answerError(a));
  }

  /** One call: its answer frames (one, or several for a long list). */
  private async call(op: number, actor: number, fields?: (w: Writer) => void): Promise<Answer[]> {
    const req = this.nextReq;
    this.nextReq = this.nextReq >= 0xffffffff ? 1 : this.nextReq + 1;
    const frame = request(op, req, actor, fields);
    const s = await this.connect();
    return new Promise<Answer[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Answers come in order: one that is late leaves the stream unusable.
        s.destroy();
        this.drop(new CoreError('unavailable', 'the core did not answer in time'));
      }, this.timeoutMs);
      this.pending.set(req, { frames: [], resolve, reject, timer });
      s.write(frame);
    });
  }

  private async one(op: number, actor: number, fields?: (w: Writer) => void): Promise<Reader> {
    const frames = await this.call(op, actor, fields);
    return new Reader(frames[frames.length - 1].body);
  }

  /** A list answer's rows, across its frames. */
  private async rows<T>(op: number, actor: number, fields: (w: Writer) => void, row: (r: Reader) => T): Promise<T[]> {
    const out: T[] = [];
    for (const f of await this.call(op, actor, fields)) {
      const r = new Reader(f.body);
      for (let n = r.u8(); n > 0; n--) out.push(row(r));
    }
    return out;
  }

  private static full(number: string): string {
    if (!isFullNumber(number)) throw new CoreError('invalid', 'not a full number');
    return number;
  }

  async numFree(actor: number, exchange: string, count: number, pattern?: string): Promise<string[]> {
    const r = await this.one(OP.numFree, actor, (w) => w.text(exchange.replace(/^\+/, '')).u8(count).text(pattern ?? ''));
    const out: string[] = [];
    for (let n = r.u8(); n > 0; n--) out.push(r.number());
    return out;
  }

  async numCheck(actor: number, number: string): Promise<NumCheck> {
    if (!isFullNumber(number)) return 'not_assignable';
    const r = await this.one(OP.numCheck, actor, (w) => w.number(number));
    return (['free', 'taken', 'not_assignable'] as const)[r.u8()] ?? 'not_assignable';
  }

  private async token(op: number, actor: number, number: string): Promise<IssuedToken> {
    const r = await this.one(op, actor, (w) => w.number(TlsCore.full(number)));
    return { number: r.number(), expiresAt: r.u32() * 1000, qr: r.text() };
  }

  subCreate(actor: number, number: string): Promise<IssuedToken> {
    return this.token(OP.subCreate, actor, number);
  }

  subReissue(actor: number, number: string): Promise<IssuedToken> {
    return this.token(OP.subReissue, actor, number);
  }

  async subStatus(actor: number, number: string): Promise<SubStatus> {
    const r = await this.one(OP.subStatus, actor, (w) => w.number(TlsCore.full(number)));
    const n = r.number();
    const activated = r.u8() === 1;
    const disabled = r.u8() === 1;
    const expiry = r.u32();
    const registered = r.u8() === 1;
    const cell = r.u32();
    const tmid = r.u16();
    const seen = r.u32();
    return {
      number: n,
      state: activated ? 'activated' : 'unactivated',
      disabled,
      tokenExpiresAt: expiry ? expiry * 1000 : null,
      registered,
      cellId: registered ? cell : null,
      tmidPrefix: activated ? tmid.toString(16).padStart(4, '0') : null,
      lastSeenAt: seen ? seen * 1000 : null,
    };
  }

  async subRelease(actor: number, number: string): Promise<void> {
    await this.call(OP.subRelease, actor, (w) => w.number(TlsCore.full(number)));
  }

  async subDisable(actor: number, number: string): Promise<void> {
    await this.call(OP.subDisable, actor, (w) => w.number(TlsCore.full(number)));
  }

  async subEnable(actor: number, number: string): Promise<void> {
    await this.call(OP.subEnable, actor, (w) => w.number(TlsCore.full(number)));
  }

  cdrList(actor: number, number: string, since: number): Promise<Cdr[]> {
    const full = TlsCore.full(number);
    return this.rows(
      OP.cdrList,
      actor,
      (w) => w.number(full).u32(Math.max(0, Math.floor(since / 1000))),
      (r) => {
        const setup = r.u32();
        const answer = r.u32();
        const end = r.u32();
        const cause = r.u8();
        const incoming = r.u8() === 1;
        const peer = r.number();
        return {
          at: setup * 1000,
          number: full,
          peer,
          direction: incoming ? 'in' : 'out',
          durationS: answer !== 0 && end > answer ? end - answer : 0,
          result: cdrResult(answer, cause),
        };
      },
    );
  }

  async cellAdd(actor: number, name: string, mode: CellMode, group: number): Promise<number> {
    const r = await this.one(OP.cellAdd, actor, (w) => w.text(name).u8(MODE[mode] ?? 0).u16(group));
    return r.u32();
  }

  async cellSetCert(actor: number, cellId: number, fpr: string): Promise<void> {
    if (!FPR.test(fpr)) throw new CoreError('invalid', 'fingerprint must be 64 lowercase hex digits');
    await this.call(OP.cellSetCert, actor, (w) => w.u32(cellId).raw(Buffer.from(fpr, 'hex')));
  }

  async cellRevoke(actor: number, cellId: number): Promise<void> {
    await this.call(OP.cellRevoke, actor, (w) => w.u32(cellId));
  }

  cellStatus(actor: number, cellId?: number): Promise<CellStatus[]> {
    return this.rows(
      OP.cellStatus,
      actor,
      (w) => w.u32(cellId ?? 0),
      (r) => {
        const id = r.u32();
        const enabled = r.u8() === 1;
        const mode: CellMode = r.u8() === 2 ? 'part97' : 'part15';
        const group = r.u16();
        const pinned = r.u8() === 1;
        const fpr = Buffer.from(r.bytes(32)).toString('hex');
        const linked = r.u8() === 1;
        const lastHello = r.u32();
        const terminals = r.u16();
        const calls = r.u16();
        const name = r.text();
        return {
          cellId: id,
          name,
          mode,
          group,
          certFpr: pinned ? fpr : null,
          revoked: !enabled,
          online: linked,
          lastHeardAt: lastHello ? lastHello * 1000 : null,
          terminals,
          calls,
        };
      },
    );
  }

  async coreStatus(actor: number): Promise<CoreStatus> {
    const r = await this.one(OP.coreStatus, actor);
    const coreId = r.u16();
    const uptimeS = r.u32();
    const cellsTotal = r.u32();
    const cellsOnline = r.u32();
    const subscribers = r.u32();
    const callsNow = r.u16();
    return { coreId, uptimeS, cellsTotal, cellsOnline, subscribers, callsNow, name: r.text(), version: r.text() };
  }

  async routeOffer(actor: number, tableVersion: number, _blob: Uint8Array, _sig: Uint8Array): Promise<void> {
    // The core refuses it until P5 (the signed table and its delegation).
    await this.call(OP.routeOffer, actor, (w) => w.u32(tableVersion));
  }
}
