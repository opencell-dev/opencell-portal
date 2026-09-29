import { randomBytes, randomInt } from 'node:crypto';
import { isAssignable, isExchange, isFullNumber, numberBcd } from './numbers';
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

const TOKEN_MS = 72 * 3600_000;
const PATTERN = /^[0-9x]{5}$/;
const FPR = /^[0-9a-f]{64}$/;

interface Sub {
  number: string;
  state: 'unactivated' | 'activated';
  disabled: boolean;
  token: { id: string; expiresAt: number } | null;
  tmid: number | null;
  cellId: number | null;
  lastSeenAt: number | null;
}

interface Cell {
  cellId: number;
  name: string;
  mode: CellMode;
  group: number;
  certFpr: string | null;
  revoked: boolean;
  online: boolean;
  lastHeardAt: number | null;
}

export interface FakeAuditEntry {
  at: number;
  actor: number;
  op: string;
  arg: string;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as the QR code uses. */
export function crc16CcittFalse(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/**
 * An in-process stand-in for a core's admin API (portal spec §7), for
 * development and tests until P4. It keeps its state in memory, enforces the
 * same rules the real core will (assignable numbers, 72 h tokens released
 * when unactivated, only unactivated numbers released), and offers `sim*`
 * helpers so tests can play the terminal and cell side.
 */
export class FakeCore implements CoreAdmin {
  readonly audit: FakeAuditEntry[] = [];
  readonly routes: { tableVersion: number; size: number }[] = [];
  private readonly subs = new Map<string, Sub>();
  private readonly cdrs: Cdr[] = [];
  private readonly cells = new Map<number, Cell>();
  private nextCell = 1;
  private readonly started: number;
  private readonly networkKey = randomBytes(32);

  constructor(private readonly now: () => number = Date.now) {
    this.started = now();
  }

  private log(actor: number, op: string, arg: unknown) {
    this.audit.push({ at: this.now(), actor, op, arg: String(arg) });
  }

  /** Core-internal job (spec §7 `sub.release_expired`), run before every read. */
  releaseExpired() {
    const t = this.now();
    for (const s of this.subs.values()) {
      if (s.state === 'unactivated' && s.token && s.token.expiresAt <= t) {
        this.subs.delete(s.number);
        this.log(0, 'sub.release_expired', s.number);
      }
    }
  }

  private sub(number: string): Sub {
    this.releaseExpired();
    const s = this.subs.get(number);
    if (!s) throw new CoreError('not_found', `no subscriber ${number}`);
    return s;
  }

  private issue(s: Sub): IssuedToken {
    const id = Buffer.concat([Buffer.from([0x00, 0x01]), randomBytes(6)]); // block index 1
    const expiresAt = this.now() + TOKEN_MS;
    s.token = { id: id.toString('hex'), expiresAt };
    const b = Buffer.alloc(75);
    b[0] = 2;
    b.writeUInt16LE(1, 1);
    this.networkKey.copy(b, 3);
    id.copy(b, 35);
    randomBytes(16).copy(b, 43);
    Buffer.from(numberBcd(s.number)).copy(b, 59);
    b.writeUInt32LE(Math.floor(expiresAt / 1000), 67);
    b.writeUInt16LE(crc16CcittFalse(b.subarray(0, 73)), 73);
    return { number: s.number, qr: `opencell:2:${b.toString('base64url')}`, expiresAt };
  }

  async numFree(actor: number, exchange: string, count: number, pattern?: string): Promise<string[]> {
    this.log(actor, 'num.free', `${exchange} ${count} ${pattern ?? ''}`.trim());
    if (!isExchange(exchange)) throw new CoreError('invalid', 'exchange must be +8831NPANXX');
    if (!Number.isInteger(count) || count < 1 || count > 32) throw new CoreError('invalid', 'count must be 1–32');
    if (pattern !== undefined && !PATTERN.test(pattern)) throw new CoreError('invalid', 'pattern must be 5 of [0-9x]');
    this.releaseExpired();
    const out = new Set<string>();
    for (let tries = 0; out.size < count && tries < 20_000; tries++) {
      let station = String(randomInt(1000, 99999)).padStart(5, '0');
      if (pattern) station = [...pattern].map((c, i) => (c === 'x' ? station[i] : c)).join('');
      const n = exchange + station;
      if (isAssignable(n) && !this.subs.has(n)) out.add(n);
    }
    return [...out];
  }

  async numCheck(actor: number, number: string): Promise<NumCheck> {
    this.log(actor, 'num.check', number);
    this.releaseExpired();
    if (!isAssignable(number)) return 'not_assignable';
    return this.subs.has(number) ? 'taken' : 'free';
  }

  async subCreate(actor: number, number: string): Promise<IssuedToken> {
    this.log(actor, 'sub.create', number);
    this.releaseExpired();
    if (!isAssignable(number)) throw new CoreError('not_assignable', `${number} is not assignable`);
    if (this.subs.has(number)) throw new CoreError('taken', `${number} is taken`);
    const s: Sub = { number, state: 'unactivated', disabled: false, token: null, tmid: null, cellId: null, lastSeenAt: null };
    this.subs.set(number, s);
    return this.issue(s);
  }

  async subReissue(actor: number, number: string): Promise<IssuedToken> {
    this.log(actor, 'sub.reissue', number);
    const s = this.sub(number);
    if (s.disabled) throw new CoreError('invalid', `${number} is disabled`);
    return this.issue(s);
  }

  async subStatus(actor: number, number: string): Promise<SubStatus> {
    this.log(actor, 'sub.status', number);
    const s = this.sub(number);
    return {
      number: s.number,
      state: s.state,
      disabled: s.disabled,
      tokenExpiresAt: s.state === 'unactivated' && s.token ? s.token.expiresAt : null,
      registered: s.cellId !== null,
      cellId: s.cellId,
      tmidPrefix: s.tmid === null ? null : s.tmid.toString(16).padStart(8, '0').slice(0, 4),
      lastSeenAt: s.lastSeenAt,
    };
  }

  async subRelease(actor: number, number: string): Promise<void> {
    this.log(actor, 'sub.release', number);
    const s = this.sub(number);
    if (s.state !== 'unactivated') throw new CoreError('not_unactivated', `${number} is activated`);
    this.subs.delete(number);
  }

  async subDisable(actor: number, number: string): Promise<void> {
    this.log(actor, 'sub.disable', number);
    const s = this.sub(number);
    s.disabled = true;
    s.cellId = null;
  }

  async subEnable(actor: number, number: string): Promise<void> {
    this.log(actor, 'sub.enable', number);
    this.sub(number).disabled = false;
  }

  async cdrList(actor: number, number: string, since: number): Promise<Cdr[]> {
    this.log(actor, 'cdr.list', number);
    if (!isFullNumber(number)) throw new CoreError('invalid', 'not a full number');
    return this.cdrs.filter((c) => c.number === number && c.at >= since).map((c) => ({ ...c }));
  }

  async cellAdd(actor: number, name: string, mode: CellMode, group: number): Promise<number> {
    this.log(actor, 'cell.add', name);
    if (name.length < 1 || name.length > 32) throw new CoreError('invalid', 'name must be 1–32 characters');
    if (!Number.isInteger(group) || group < 0 || group > 65535) throw new CoreError('invalid', 'group must be 0–65535');
    const cellId = this.nextCell++;
    this.cells.set(cellId, { cellId, name, mode, group, certFpr: null, revoked: false, online: false, lastHeardAt: null });
    return cellId;
  }

  private cell(cellId: number): Cell {
    const c = this.cells.get(cellId);
    if (!c) throw new CoreError('not_found', `no cell ${cellId}`);
    return c;
  }

  async cellSetCert(actor: number, cellId: number, fpr: string): Promise<void> {
    this.log(actor, 'cell.set_cert', cellId);
    const c = this.cell(cellId);
    if (!FPR.test(fpr)) throw new CoreError('invalid', 'fingerprint must be 64 lowercase hex digits');
    c.certFpr = fpr;
  }

  async cellRevoke(actor: number, cellId: number): Promise<void> {
    this.log(actor, 'cell.revoke', cellId);
    const c = this.cell(cellId);
    c.revoked = true;
    c.online = false;
    c.certFpr = null;
  }

  async cellStatus(actor: number, cellId?: number): Promise<CellStatus[]> {
    this.log(actor, 'cell.status', cellId ?? 'all');
    const list = cellId === undefined ? [...this.cells.values()] : [this.cell(cellId)];
    return list.map((c) => {
      const here = [...this.subs.values()].filter((s) => s.cellId === c.cellId);
      return { ...c, terminals: here.length, calls: 0 };
    });
  }

  async coreStatus(actor: number): Promise<CoreStatus> {
    this.log(actor, 'core.status', '');
    this.releaseExpired();
    const cells = [...this.cells.values()];
    return {
      coreId: 1,
      name: 'fake-core',
      version: '0.0.0-fake',
      uptimeS: Math.floor((this.now() - this.started) / 1000),
      cellsTotal: cells.length,
      cellsOnline: cells.filter((c) => c.online).length,
      subscribers: [...this.subs.values()].filter((s) => s.state === 'activated').length,
      callsNow: 0,
    };
  }

  async routeOffer(actor: number, tableVersion: number, blob: Uint8Array, sig: Uint8Array): Promise<void> {
    this.log(actor, 'route.offer', tableVersion);
    if (blob.length === 0 || sig.length !== 64) throw new CoreError('invalid', 'empty table or bad signature length');
    this.routes.push({ tableVersion, size: blob.length });
  }

  // ---- simulation of the terminal and cell side (tests, development) ----

  /** A terminal activates with this QR text (activation spec §3.2). */
  simActivate(qr: string, tmid: number): void {
    const b = Buffer.from(qr.replace(/^opencell:2:/, ''), 'base64url');
    const id = b.subarray(35, 43).toString('hex');
    this.releaseExpired();
    const s = [...this.subs.values()].find((x) => x.token?.id === id);
    if (!s || !s.token) throw new CoreError('not_found', 'unknown or voided token');
    if (s.token.expiresAt <= this.now()) throw new CoreError('invalid', 'token expired');
    s.state = 'activated';
    s.token = null;
    s.tmid = tmid >>> 0;
    s.cellId = null;
    s.lastSeenAt = this.now();
  }

  simRegister(number: string, cellId: number): void {
    const s = this.sub(number);
    this.cell(cellId);
    s.cellId = cellId;
    s.lastSeenAt = this.now();
  }

  simCall(cdr: Omit<Cdr, 'at'>): void {
    this.cdrs.push({ at: this.now(), ...cdr });
  }

  simCellOnline(cellId: number, online: boolean): void {
    const c = this.cell(cellId);
    c.online = online;
    c.lastHeardAt = this.now();
  }

  /** Every number this core holds, for tests. */
  numbers(): string[] {
    this.releaseExpired();
    return [...this.subs.keys()];
  }
}
