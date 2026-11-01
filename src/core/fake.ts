import { createPublicKey, randomBytes, randomInt, verify } from 'node:crypto';
import { isAssignable, isExchange, isFullNumber, numberBcd } from './numbers';
import { EAST_STATES, STATE_CODE, WEST_STATES } from './state-codes';
import {
  type AuditQuery,
  type Cdr,
  type CdrRecord,
  type CellMode,
  type CellStatus,
  type CoreAdmin,
  type CoreAuditRecord,
  type CoreBlock,
  CoreError,
  type CoreStatus,
  type IssuedToken,
  type NumCheck,
  type OcssPeer,
  type RadioStatus,
  type Registration,
  type RegListQuery,
  type RouteOffered,
  type RouteStatus,
  type SubStatus,
} from './types';
import { cdrResult } from './wire';
import { AUDIT_API, AUDIT_LIST_MAX, AUDIT_REGISTER, CDR_RECENT_MAX, REG_LIST_MAX } from './wire-noc';

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
  /** Registered on another core's cell (OCSS spec §5.6): that core; absent: `cellId` is this core's own. */
  visiting?: number;
  lastSeenAt: number | null;
  /** When it last registered (reg.list's registered at). */
  registeredAt?: number | null;
  /** Its cell's latest signal for it (reg.list), or none reported. */
  signal?: { rssiDbm: number; snrDb: number; heardAt: number } | null;
}

/** A radio as its cell last reported it (cell.radio without the cell id). */
export type FakeRadio = Omit<RadioStatus, 'cellId'>;

interface Cell {
  cellId: number;
  name: string;
  mode: CellMode;
  group: number;
  certFpr: string | null;
  revoked: boolean;
  online: boolean;
  lastHeardAt: number | null;
  /** Its radios' latest report: shown by cell.radio while it is online. */
  radios?: FakeRadio[];
}

/** Which core a FakeCore plays (NOC design §10): core.status's id, name and version. */
export interface FakeCoreOptions {
  coreId?: number;
  name?: string;
  version?: string;
  /** core.blocks; default: home for 8831717, block index = core id. */
  blocks?: CoreBlock[];
}

/** The fake core keeps at most this many of its own audit records (cell.radio polls add one each). */
export const FAKE_CORE_AUDIT_MAX = 20_000;
/** A fake registration expires this long after it is read (the fake keeps registrations until deregistered). */
export const FAKE_REG_TTL_MS = 3600_000;

/**
 * A simulated outage (NOC design §10): 'refuse' fails every call at once
 * (connection refused); 'hang' fails it after HANG_MS, as TlsCore's own
 * timeout does, so a page's 3 s deadline gives up first.
 */
export type FakeDown = 'refuse' | 'hang' | null;
export const HANG_MS = 5000;

const FAKE = Symbol.for('opencell.FakeCore');

/**
 * The fake core behind a CoreAdmin, or null. Not `instanceof`: Next's
 * production build can load this module more than once (one copy per server
 * bundle), and the cores are made once per process (globalThis.__ocCores) by
 * whichever copy came first, so a class check from another copy fails. A
 * Symbol.for brand is the same in every copy.
 */
export function asFakeCore(c: unknown): FakeCore | null {
  return typeof c === 'object' && c !== null && (c as Record<symbol, unknown>)[FAKE] === true ? (c as FakeCore) : null;
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

/** A fake core's delegation names core 1 for East and core 2 for West, as the deployed table does. */
const EAST_CORE = 1;
const WEST_CORE = 2;

/** An addition blob (OCSS spec §3.2), or null if it is malformed (rule 2). Separate from the portal's own builder, on purpose. */
function parseAddition(blob: Buffer): { rootVersion: number; seq: number; delegate: Buffer; blocks: { npa: string; index: number; state: string }[] } | null {
  if (blob.length < 48 || blob.length > 400 || blob.subarray(0, 4).toString('latin1') !== 'OCRA' || blob[4] !== 1) return null;
  const n = blob[47];
  if (n < 1 || n > 16) return null;
  const blocks: { npa: string; index: number; state: string }[] = [];
  let o = 48;
  for (let i = 0; i < n; i++) {
    if (o + 6 > blob.length) return null;
    const npa = blob.subarray(o, o + 3).toString('latin1');
    const len = blob[o + 5];
    if (o + 6 + len > blob.length) return null;
    const state = blob.subarray(o + 6, o + 6 + len).toString('latin1');
    if (!/^[2-9]\d\d$/.test(npa) || npa.endsWith('11') || npa === '883' || !STATE_CODE.test(state)) return null;
    blocks.push({ npa, index: blob.readUInt16LE(o + 3), state });
    o += 6 + len;
  }
  if (o !== blob.length) return null;
  return { rootVersion: blob.readUInt32LE(5), seq: blob.readUInt16LE(9), delegate: blob.subarray(15, 47), blocks };
}

function signedBy(blob: Buffer, delegate: Buffer, sig: Uint8Array): boolean {
  try {
    // SubjectPublicKeyInfo for Ed25519: a fixed 12-byte prefix, then the raw key.
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), delegate]), format: 'der', type: 'spki' });
    return verify(null, blob, key, sig);
  } catch {
    return false;
  }
}

/**
 * An in-process stand-in for a core's admin API (portal spec §7), for
 * development and tests until P4. It keeps its state in memory, enforces the
 * same rules the real core will (assignable numbers, 72 h tokens released
 * when unactivated, only unactivated numbers released), and offers `sim*`
 * helpers so tests can play the terminal and cell side.
 */
export class FakeCore implements CoreAdmin {
  readonly [FAKE] = true;
  readonly audit: FakeAuditEntry[] = [];
  private readonly subs = new Map<string, Sub>();
  private readonly cdrs: Cdr[] = [];
  private readonly cells = new Map<number, Cell>();
  private nextCell = 1;
  private readonly started: number;
  private readonly networkKey = randomBytes(32);
  private readonly activeCalls = new Map<number, number>();
  private down: FakeDown = null;
  private readonly records: CdrRecord[] = [];
  private nextCdrId = 1;
  private readonly coreAudit: CoreAuditRecord[] = [];
  private nextAuditId = 1;
  private peers: OcssPeer[] = [];
  private blocks: CoreBlock[];
  private route = { signed: false, rootVersion: 0, seq: 0, maxIdx: 0, delegateNotAfter: null as number | null };
  /** The additions taken, by seq, for a repeat (OCSS spec §3.5 rule 3). */
  private readonly additions = new Map<number, Buffer>();
  readonly coreId: number;
  readonly name: string;
  readonly version: string;

  constructor(
    private readonly now: () => number = Date.now,
    opts: FakeCoreOptions = {},
  ) {
    this.started = now();
    this.coreId = opts.coreId ?? 1;
    this.name = opts.name ?? 'fake-core';
    this.version = opts.version ?? '0.0.0-fake';
    this.blocks = opts.blocks ?? [{ index: this.coreId, homeCore: this.coreId, role: 'home', prefix: '8831717' }];
  }

  /** Every call starts here: a simulated outage fails it before anything is done or audited. */
  private async gate(): Promise<void> {
    if (this.down === 'refuse') throw new CoreError('unavailable', 'connect ECONNREFUSED (simulated)');
    if (this.down === 'hang') {
      await new Promise((resolve) => setTimeout(resolve, HANG_MS).unref());
      throw new CoreError('unavailable', 'the core did not answer in time (simulated)');
    }
  }

  private log(actor: number, op: string, arg: unknown) {
    this.audit.push({ at: this.now(), actor, op, arg: String(arg) });
    // The core's own audit (audit.list): an API record, "a<actor> <op> ok", as oc_api writes one.
    const text = String(arg);
    this.simAuditRecord({
      at: this.now(),
      event: AUDIT_API,
      number: isFullNumber(text) ? text : null,
      tmidPrefix: null,
      cellId: /^cell\./.test(op) && /^\d+$/.test(text) ? Number(text) : null,
      detail: `a${actor} ${op} ok`,
    });
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
    await this.gate();
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
    await this.gate();
    this.log(actor, 'num.check', number);
    this.releaseExpired();
    if (!isAssignable(number)) return 'not_assignable';
    return this.subs.has(number) ? 'taken' : 'free';
  }

  async subCreate(actor: number, number: string): Promise<IssuedToken> {
    await this.gate();
    this.log(actor, 'sub.create', number);
    this.releaseExpired();
    if (!isAssignable(number)) throw new CoreError('not_assignable', `${number} is not assignable`);
    if (this.subs.has(number)) throw new CoreError('taken', `${number} is taken`);
    const s: Sub = { number, state: 'unactivated', disabled: false, token: null, tmid: null, cellId: null, lastSeenAt: null };
    this.subs.set(number, s);
    return this.issue(s);
  }

  async subReissue(actor: number, number: string): Promise<IssuedToken> {
    await this.gate();
    this.log(actor, 'sub.reissue', number);
    const s = this.sub(number);
    if (s.disabled) throw new CoreError('invalid', `${number} is disabled`);
    return this.issue(s);
  }

  async subStatus(actor: number, number: string): Promise<SubStatus> {
    await this.gate();
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
      servingCore: s.cellId === null ? null : (s.visiting ?? this.coreId),
    };
  }

  async subRelease(actor: number, number: string): Promise<void> {
    await this.gate();
    this.log(actor, 'sub.release', number);
    this.releaseExpired();
    const s = this.subs.get(number);
    if (!s) return; // free already (the 72 h job, an earlier call): a release is idempotent
    if (s.state !== 'unactivated') throw new CoreError('not_unactivated', `${number} is activated`);
    this.subs.delete(number);
  }

  async subDisable(actor: number, number: string): Promise<void> {
    await this.gate();
    this.log(actor, 'sub.disable', number);
    const s = this.sub(number);
    s.disabled = true;
    s.cellId = null;
  }

  async subEnable(actor: number, number: string): Promise<void> {
    await this.gate();
    this.log(actor, 'sub.enable', number);
    this.sub(number).disabled = false;
  }

  async cdrList(actor: number, number: string, since: number): Promise<Cdr[]> {
    await this.gate();
    this.log(actor, 'cdr.list', number);
    if (!isFullNumber(number)) throw new CoreError('invalid', 'not a full number');
    return this.cdrs.filter((c) => c.number === number && c.at >= since).map((c) => ({ ...c }));
  }

  async cellAdd(actor: number, name: string, mode: CellMode, group: number): Promise<number> {
    await this.gate();
    this.log(actor, 'cell.add', name);
    return this.simAddCell(name, mode, group);
  }

  private cell(cellId: number): Cell {
    const c = this.cells.get(cellId);
    if (!c) throw new CoreError('not_found', `no cell ${cellId}`);
    return c;
  }

  async cellSetCert(actor: number, cellId: number, fpr: string): Promise<void> {
    await this.gate();
    this.log(actor, 'cell.set_cert', cellId);
    const c = this.cell(cellId);
    if (!FPR.test(fpr)) throw new CoreError('invalid', 'fingerprint must be 64 lowercase hex digits');
    c.certFpr = fpr;
  }

  async cellRevoke(actor: number, cellId: number): Promise<void> {
    await this.gate();
    this.log(actor, 'cell.revoke', cellId);
    const c = this.cell(cellId);
    c.revoked = true;
    c.online = false;
    c.certFpr = null;
    this.activeCalls.delete(cellId); // its link drops, and its calls with it
  }

  async cellStatus(actor: number, cellId?: number): Promise<CellStatus[]> {
    await this.gate();
    this.log(actor, 'cell.status', cellId ?? 'all');
    const list = cellId === undefined ? [...this.cells.values()] : [this.cell(cellId)];
    return list.map((c) => {
      const here = [...this.subs.values()].filter((s) => s.cellId === c.cellId && s.visiting === undefined);
      return { ...c, terminals: here.length, calls: this.activeCalls.get(c.cellId) ?? 0 };
    });
  }

  async coreStatus(actor: number): Promise<CoreStatus> {
    await this.gate();
    this.log(actor, 'core.status', '');
    this.releaseExpired();
    const cells = [...this.cells.values()];
    return {
      coreId: this.coreId,
      name: this.name,
      version: this.version,
      uptimeS: Math.floor((this.now() - this.started) / 1000),
      cellsTotal: cells.length,
      cellsOnline: cells.filter((c) => c.online).length,
      subscribers: [...this.subs.values()].filter((s) => s.state === 'activated').length,
      callsNow: [...this.activeCalls.values()].reduce((a, b) => a + b, 0),
    };
  }

  /** OCSS spec §3.5's rules in its order, against this fake's own table (rule 4's delegation is not modelled). */
  async routeOffer(actor: number, tableVersion: number, blob: Uint8Array, sig: Uint8Array): Promise<RouteOffered> {
    await this.gate();
    this.log(actor, 'route.offer', tableVersion);
    const r = this.route;
    if (!r.signed) throw new CoreError('unsupported', 'no signed table here (block lines)');
    const bytes = Buffer.from(blob);
    const a = sig.length === 64 ? parseAddition(bytes) : null;
    if (!a) throw new CoreError('invalid', 'malformed');
    if (a.rootVersion !== tableVersion || tableVersion !== r.rootVersion) throw new CoreError('invalid', `root version ${r.rootVersion} expected`);
    const held = this.additions.get(a.seq);
    if (a.seq <= r.seq && held?.equals(bytes)) {
      if (!signedBy(bytes, a.delegate, sig)) throw new CoreError('invalid', 'bad signature');
      return { rootVersion: r.rootVersion, seq: r.seq, blocks: this.blocks.length, isNew: false };
    }
    if (!signedBy(bytes, a.delegate, sig)) throw new CoreError('invalid', 'bad signature');
    if (a.seq <= r.seq) throw new CoreError('taken', `seq ${a.seq} holds another addition`);
    if (a.seq > r.seq + 1) throw new CoreError('invalid', `out of order: at seq ${r.seq}`);
    const prefixes = new Set(this.blocks.map((b) => b.prefix));
    let floor = this.maxIdx();
    for (const b of a.blocks) {
      const prefix = `8831${b.npa}`;
      if (prefixes.has(prefix)) throw new CoreError('invalid', `rule: ${b.npa} is in the table`);
      if (b.index <= floor) throw new CoreError('invalid', `rule: index ${b.index} is not above ${floor}`);
      if (!EAST_STATES.has(b.state) && !WEST_STATES.has(b.state)) throw new CoreError('invalid', `rule: ${b.state} is in neither list`);
      prefixes.add(prefix);
      floor = b.index;
    }
    for (const b of a.blocks) {
      const homeCore = EAST_STATES.has(b.state) ? EAST_CORE : WEST_CORE;
      this.blocks.push({ index: b.index, homeCore, role: homeCore === this.coreId ? 'home' : 'secondary', prefix: `8831${b.npa}` });
    }
    this.additions.set(a.seq, bytes);
    r.seq = a.seq;
    return { rootVersion: r.rootVersion, seq: r.seq, blocks: this.blocks.length, isNew: true };
  }

  async routeStatus(actor: number): Promise<RouteStatus> {
    await this.gate();
    this.log(actor, 'route.status', '');
    const { signed, rootVersion, seq, delegateNotAfter } = this.route;
    return { signed, rootVersion, seq, blocks: this.blocks.length, maxIdx: this.maxIdx(), delegateNotAfter };
  }

  private maxIdx(): number {
    return Math.max(this.route.maxIdx, ...this.blocks.map((b) => b.index));
  }

  // ---- the NOC's operations (NOC design §7.1), as core v0.4.0 answers them

  async cellRadio(actor: number, cellId?: number): Promise<RadioStatus[]> {
    await this.gate();
    this.log(actor, 'cell.radio', cellId ?? 'all');
    const list = cellId === undefined || cellId === 0 ? [...this.cells.values()] : [this.cell(cellId)];
    return list
      .filter((c) => c.online && !c.revoked)
      .sort((a, b) => a.cellId - b.cellId)
      .flatMap((c) => (c.radios ?? []).map((r) => ({ ...r, cellId: c.cellId })));
  }

  async regList(actor: number, q: RegListQuery = {}): Promise<Registration[]> {
    await this.gate();
    this.log(actor, 'reg.list', q.after ?? (q.cellId ? `cell ${q.cellId}` : 'all'));
    if (q.after !== undefined && !isFullNumber(q.after)) throw new CoreError('invalid', 'after: not a full number');
    if (q.cellId) this.cell(q.cellId);
    this.releaseExpired();
    const t = this.now();
    return [...this.subs.values()]
      .filter((s) => s.cellId !== null && s.visiting === undefined && (!q.cellId || s.cellId === q.cellId) && (q.after === undefined || s.number > q.after))
      .sort((a, b) => (a.number < b.number ? -1 : 1))
      .slice(0, REG_LIST_MAX)
      .map((s) => ({
        number: s.number,
        tmidPrefix: (s.tmid ?? 0).toString(16).padStart(8, '0').slice(0, 4),
        cellId: s.cellId as number,
        registeredAt: s.registeredAt ?? null,
        expiresAt: t + FAKE_REG_TTL_MS,
        rssiDbm: s.signal?.rssiDbm ?? null,
        snrDb: s.signal?.snrDb ?? null,
        heardAt: s.signal?.heardAt ?? null,
      }));
  }

  async cdrRecent(actor: number, after: number, limit: number): Promise<CdrRecord[]> {
    await this.gate();
    this.log(actor, 'cdr.recent', `after ${after}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > CDR_RECENT_MAX) throw new CoreError('invalid', 'after (4), limit 1-1000');
    return this.records
      .filter((r) => r.id > after)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async auditList(actor: number, q: AuditQuery): Promise<CoreAuditRecord[]> {
    await this.gate();
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > AUDIT_LIST_MAX) throw new CoreError('invalid', 'after (4), mask (4), number, limit 1-500');
    if (q.number !== undefined && !isFullNumber(q.number)) throw new CoreError('invalid', 'not a full number');
    const events = new Set(q.events ?? []);
    if ([...events].some((e) => !Number.isInteger(e) || e < 0 || e > 31)) throw new CoreError('invalid', 'an event is 0–31');
    // Answered first, then audited, as oc_api does: the call's own record is not in its answer.
    const out = this.coreAudit
      .filter((r) => r.id > (q.after ?? 0) && (events.size === 0 || events.has(r.event)) && (q.number === undefined || r.number === q.number))
      .slice(0, q.limit)
      .map((r) => ({ ...r }));
    this.log(actor, 'audit.list', q.number ?? `after ${q.after ?? 0}`);
    return out;
  }

  async ocssStatus(actor: number): Promise<OcssPeer[]> {
    await this.gate();
    this.log(actor, 'ocss.status', '');
    return this.peers.map((p) => ({ ...p }));
  }

  async coreBlocks(actor: number): Promise<CoreBlock[]> {
    await this.gate();
    this.log(actor, 'core.blocks', '');
    return this.blocks.map((b) => ({ ...b }));
  }

  async cellMode(actor: number, cellId: number, mode: CellMode): Promise<void> {
    await this.gate();
    this.log(actor, 'cell.mode', cellId);
    if (mode !== 'part15' && mode !== 'part97') throw new CoreError('invalid', 'mode: 1 part15, 2 part97');
    const c = this.cell(cellId);
    if (c.revoked) throw new CoreError('invalid', 'revoked');
    if (c.mode === mode) return; // idempotent: already that mode, the link stays up (final review M4)
    c.mode = mode;
    // The link drops and its calls end; the fake cell is back at once, in the new mode.
    this.activeCalls.delete(cellId);
    if (c.online) {
      c.lastHeardAt = this.now();
      for (const r of c.radios ?? []) r.reportedAt = this.now();
    }
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

  /** It registers on one of this core's cells, or (`servingCore`) on cell `cellId` of another core: a visitor there, homed here. */
  simRegister(number: string, cellId: number, servingCore?: number): void {
    const s = this.sub(number);
    const away = servingCore !== undefined && servingCore !== this.coreId;
    if (!away) this.cell(cellId);
    s.cellId = cellId;
    s.visiting = away ? servingCore : undefined;
    s.lastSeenAt = this.now();
    s.registeredAt = this.now();
    this.registerRecord(s, this.now());
  }

  private registerRecord(s: Sub, at: number): void {
    this.simAuditRecord({
      at,
      event: AUDIT_REGISTER,
      number: s.number,
      tmidPrefix: s.tmid === null ? null : s.tmid.toString(16).padStart(8, '0').slice(0, 4),
      cellId: s.cellId,
      detail: 'register',
    });
  }

  /** A finished call's CDR, now or (`at`) at an earlier time. */
  simCall(cdr: Omit<Cdr, 'at'> & { at?: number }): void {
    this.cdrs.push({ ...cdr, at: cdr.at ?? this.now() });
  }

  /** Calls in progress on a cell (cell.status calls, core.status callsNow). */
  simActiveCalls(cellId: number, n: number): void {
    this.cell(cellId);
    if (n > 0) this.activeCalls.set(cellId, n);
    else this.activeCalls.delete(cellId);
  }

  /** A simulated outage from now on (null: answering again). */
  simDown(mode: FakeDown): void {
    this.down = mode;
  }

  get isDown(): FakeDown {
    return this.down;
  }

  simCellOnline(cellId: number, online: boolean): void {
    const c = this.cell(cellId);
    c.online = online;
    c.lastHeardAt = this.now();
    if (!online) this.activeCalls.delete(cellId); // a lost link releases its calls
  }

  /** cell.add without the call (the demo's seeding): the same checks, nothing audited. */
  simAddCell(name: string, mode: CellMode, group: number, certFpr: string | null = null): number {
    if (name.length < 1 || name.length > 32) throw new CoreError('invalid', 'name must be 1–32 characters');
    if (!Number.isInteger(group) || group < 0 || group > 65535) throw new CoreError('invalid', 'group must be 0–65535');
    if (certFpr !== null && !FPR.test(certFpr)) throw new CoreError('invalid', 'fingerprint must be 64 lowercase hex digits');
    const cellId = this.nextCell++;
    this.cells.set(cellId, { cellId, name, mode, group, certFpr, revoked: false, online: false, lastHeardAt: null });
    return cellId;
  }

  /** An activated subscriber bound to `tmid`, registered on `cellId` (or not), with no token ever shown: the demo's seeding. */
  simSubscriber(number: string, tmid: number, cellId: number | null): void {
    if (!isAssignable(number)) throw new CoreError('not_assignable', `${number} is not assignable`);
    if (this.subs.has(number)) throw new CoreError('taken', `${number} is taken`);
    if (cellId !== null) this.cell(cellId);
    this.subs.set(number, {
      number,
      state: 'activated',
      disabled: false,
      token: null,
      tmid: tmid >>> 0,
      cellId,
      lastSeenAt: this.now(),
      registeredAt: cellId === null ? null : this.now(),
    });
  }

  /** A cell that went quiet at `since` (unix ms): offline, last heard then, its calls released. */
  simCellOffline(cellId: number, since: number): void {
    const c = this.cell(cellId);
    c.online = false;
    c.lastHeardAt = since;
    this.activeCalls.delete(cellId);
  }

  /** Back to empty (the demo's reset): no subscribers, cells, CDRs, calls or outage; the audit is kept. */
  simReset(): void {
    this.subs.clear();
    this.cdrs.length = 0;
    this.cells.clear();
    this.activeCalls.clear();
    this.nextCell = 1;
    this.down = null;
    // Ids keep rising (a real core's never go back): a cursor from before still reads only what is new.
    this.records.length = 0;
    this.coreAudit.length = 0;
    this.peers = [];
  }

  /** The cells as they are, outage or not (the demo controls), without a call or an audit record. */
  simCells(): { cellId: number; name: string; online: boolean; revoked: boolean }[] {
    return [...this.cells.values()].map(({ cellId, name, online, revoked }) => ({ cellId, name, online, revoked }));
  }

  /** A finished call as the core records it (cdr.recent), and its two sides in cdr.list. */
  simCdr(rec: Omit<CdrRecord, 'id'>): CdrRecord {
    const r: CdrRecord = { ...rec, id: this.nextCdrId++ };
    this.records.push(r);
    const durationS = r.answerAt !== null && r.endAt > r.answerAt ? Math.floor((r.endAt - r.answerAt) / 1000) : 0;
    const result = cdrResult(r.answerAt === null ? 0 : 1, r.cause);
    this.cdrs.push({ at: r.setupAt, number: r.caller, peer: r.called, direction: 'out', durationS, result });
    if (r.legB === 'cell') this.cdrs.push({ at: r.setupAt, number: r.called, peer: r.caller, direction: 'in', durationS, result });
    return r;
  }

  /** A record in the core's own audit (audit.list), with the next id. */
  simAuditRecord(rec: Omit<CoreAuditRecord, 'id'>): void {
    this.coreAudit.push({ ...rec, id: this.nextAuditId++ });
    if (this.coreAudit.length > FAKE_CORE_AUDIT_MAX) this.coreAudit.splice(0, this.coreAudit.length - FAKE_CORE_AUDIT_MAX);
  }

  /** A cell's radios as its latest CELL_STATUS reported them (cell.radio); [] none. */
  simRadio(cellId: number, radios: FakeRadio[]): void {
    this.cell(cellId).radios = radios.map((r) => ({ ...r }));
  }

  /** A registered terminal's signal as its cell reported it (reg.list), or null: not in the report. */
  simSignal(number: string, signal: { rssiDbm: number; snrDb: number; heardAt: number } | null): void {
    this.sub(number).signal = signal;
  }

  /** A registration that happened at `at` (a REGISTER record then; the demo's history). */
  simRegisteredAt(number: string, at: number): void {
    const s = this.sub(number);
    s.registeredAt = at;
    this.registerRecord(s, at);
  }

  simPeers(peers: OcssPeer[]): void {
    this.peers = peers.map((p) => ({ ...p }));
  }

  /** core.blocks as they are now and, with `status`, the table route.status reports (`blocks` is always counted). */
  simBlocks(blocks: CoreBlock[], status: Partial<RouteStatus> = {}): void {
    this.blocks = blocks.map((b) => ({ ...b }));
    const { blocks: _counted, ...rest } = status;
    this.route = { ...this.route, ...rest };
    if (status.rootVersion !== undefined) this.additions.clear();
  }

  /** Every number this core holds, for tests. */
  numbers(): string[] {
    this.releaseExpired();
    return [...this.subs.keys()];
  }
}
