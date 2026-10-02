// The core admin API as the portal sees it (portal spec §7): FakeCore
// (in-process, OC_CORE=fake) or TlsCore (oc-core's port 7444, OC_CORE=tls).
// Every operation takes `actor`: the portal account id on whose behalf it
// acts (0 for the portal itself), which the core writes to its audit.

export type NumCheck = 'free' | 'taken' | 'not_assignable';

export interface IssuedToken {
  number: string;
  /** The activation QR text, `opencell:2:…` (numbering v2 §6.1). Shown once. */
  qr: string;
  /** Unix ms; the core releases an unactivated number at this time. */
  expiresAt: number;
}

export interface SubStatus {
  number: string;
  state: 'unactivated' | 'activated';
  disabled: boolean;
  tokenExpiresAt: number | null;
  registered: boolean;
  cellId: number | null;
  /** The first 2 bytes of the bound TMID, hex, or null before activation. */
  tmidPrefix: string | null;
  lastSeenAt: number | null;
}

export interface Cdr {
  at: number;
  number: string;
  peer: string;
  direction: 'in' | 'out';
  durationS: number;
  result: 'answered' | 'busy' | 'unreachable' | 'no_answer' | 'failed';
}

export type CellMode = 'part15' | 'part97';

export interface CellStatus {
  cellId: number;
  name: string;
  mode: CellMode;
  group: number;
  certFpr: string | null;
  revoked: boolean;
  online: boolean;
  lastHeardAt: number | null;
  terminals: number;
  calls: number;
}

export interface CoreStatus {
  coreId: number;
  name: string;
  version: string;
  uptimeS: number;
  cellsTotal: number;
  cellsOnline: number;
  subscribers: number;
  callsNow: number;
}

/** A board's PPS (GPS time pulse) state as the cell reports it (NOC design §7.1); 'unknown': the board's STATUS is stale or never came. */
export type PpsState = 'unlocked' | 'locked' | 'holdover';

/**
 * cell.radio (0x10): one radio of a linked cell, from its latest CELL_STATUS
 * (NOC design §7.3). Counters are since the cell's (or the board's) boot.
 */
export interface RadioStatus {
  cellId: number;
  radio: number;
  /** 1: a base-station board, 2: a bench board (oc-cell's `internal`); 'unknown' for anything else. */
  role: 'bs' | 'bench' | 'unknown';
  band: number;
  /** The board's firmware, "0.0.0" until bs-radio reports one. */
  fw: string;
  anchor: number;
  pps: PpsState;
  timebase: boolean;
  /** null: the board did not say (-128 on the wire). */
  tempC: number | null;
  boardUptimeS: number;
  /** When the core got the report (unix ms). */
  reportedAt: number;
  schedules: number;
  rach: number;
  attach: number;
  grants: number;
  ackErrors: number;
  ackLate: number;
  lateSlots: number;
  radioErrors: number;
  /** The board's last radio error code (int16; 0 none). */
  lastRadioError: number;
  scheduleMisses: number;
  uartCrcErrors: number;
  terminalsHeard: number;
}

/** reg.list (0x11): one live registration, with its cell's latest signal for the terminal. */
export interface Registration {
  number: string;
  tmidPrefix: string;
  cellId: number;
  /** The newest REGISTER audit record's time (unix ms), or null. */
  registeredAt: number | null;
  expiresAt: number;
  /** null: the cell's report does not name the terminal. */
  rssiDbm: number | null;
  /** In dB (the wire carries quarter dB); null as rssiDbm. */
  snrDb: number | null;
  heardAt: number | null;
}

export interface RegListQuery {
  /** Only this cell's registrations (0 or absent: every cell). */
  cellId?: number;
  /** Numbers after this one (a full number); absent: from the start. */
  after?: string;
}

/** What a call leg was (NOC design §7.1): a cell's, the echo or playback service, or a peer core's. */
export type LegKind = 'cell' | 'echo' | 'playback' | 'peer';

/** cdr.recent (0x12): one call record as the core keeps it, by its id. */
export interface CdrRecord {
  id: number;
  setupAt: number;
  /** null: never answered. */
  answerAt: number | null;
  endAt: number;
  /** oc_sig's release cause: 0 normal, 1 rejected, 2 busy, 3 no answer, 4 unreachable, 5 network failure, 6 link lost. */
  cause: number;
  caller: string;
  called: string;
  cellA: number | null;
  cellB: number | null;
  legA: LegKind;
  legB: LegKind;
}

/** audit.list (0x13): one record of the core's own audit. */
export interface CoreAuditRecord {
  id: number;
  at: number;
  /** oc_core_audit_event_t: 3 REGISTER, 11 API, … (CORE_AUDIT_EVENTS in core/wire-noc.ts). */
  event: number;
  number: string | null;
  tmidPrefix: string | null;
  cellId: number | null;
  detail: string;
}

export interface AuditQuery {
  /** Records after this id (default 0: from the first). */
  after?: number;
  /** Only these events (empty or absent: every event). */
  events?: number[];
  /** Only records about this number (a full number). */
  number?: string;
  /** 1–500. */
  limit: number;
}

export type OcssState = 'down' | 'connecting' | 'handshake' | 'open' | 'up';

/** ocss.status (0x14): one configured OCSS peer, from this core's side. */
export interface OcssPeer {
  coreId: number;
  /** This core dials it (it has the higher core id). */
  dials: boolean;
  state: OcssState;
  since: number | null;
  lastRxAt: number | null;
  lastTxAt: number | null;
  /** Calls with a leg on this peer now. */
  calls: number;
  /** Frames from it that did not decode, on its connection. */
  dropped: number;
  /** host:port this core dials, or null when the peer dials this core. */
  address: string | null;
}

/** core.blocks (0x15): one block of the numbering plan as this core is configured. */
export interface CoreBlock {
  index: number;
  homeCore: number;
  role: 'none' | 'home' | 'secondary';
  prefix: string;
}

export type CoreErrorCode =
  | 'invalid'
  | 'not_found'
  | 'taken'
  | 'not_assignable'
  | 'not_unactivated'
  | 'rate_limited'
  | 'unavailable'
  /** The core doesn't do this yet: route.offer until P5. */
  | 'unsupported';

const CORE_ERROR = Symbol.for('opencell.CoreError');

export class CoreError extends Error {
  readonly [CORE_ERROR] = true;
  constructor(
    readonly code: CoreErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}

/**
 * Whether `e` is a CoreError, by a `Symbol.for` brand rather than
 * `instanceof` (review I1, the same fix as `asFakeCore` in `core/fake.ts`):
 * Next's production build can load this module more than once (one copy
 * per server bundle). The cores are made once per process
 * (`globalThis.__ocCores`) by whichever copy came first, so a CoreError it
 * throws can belong to a different module copy than the one a later
 * request's code checks `instanceof` against, and the check silently fails.
 * The `Symbol.for` brand is the same object in every copy, so this holds
 * even when the thrower and the catcher are different copies of this class.
 */
export function isCoreError(e: unknown): e is CoreError {
  return typeof e === 'object' && e !== null && (e as Record<symbol, unknown>)[CORE_ERROR] === true;
}

/**
 * A core the portal knows (plan P4b): its id in the config (core1, core2;
 * 'fake' for the fake core), where it listens (for the admin page), and its
 * client. The admin dashboard shows every core; number and subscriber
 * operations go to the first until P5.
 */
export interface CoreHandle {
  id: string;
  where: string;
  core: CoreAdmin;
}

export interface CoreAdmin {
  /** Up to `count` (1–32) random free numbers in an exchange (+8831NPANXX);
   *  `pattern` is 5 characters of digits and `x` over the last five digits. */
  numFree(actor: number, exchange: string, count: number, pattern?: string): Promise<string[]>;
  numCheck(actor: number, number: string): Promise<NumCheck>;
  subCreate(actor: number, number: string): Promise<IssuedToken>;
  subReissue(actor: number, number: string): Promise<IssuedToken>;
  subStatus(actor: number, number: string): Promise<SubStatus>;
  /**
   * Only an unactivated number can be released (CoreError not_unactivated).
   * Idempotent: a number that is free already (released by the 72 h job or
   * an earlier call, or never taken) resolves too.
   */
  subRelease(actor: number, number: string): Promise<void>;
  subDisable(actor: number, number: string): Promise<void>;
  subEnable(actor: number, number: string): Promise<void>;
  cdrList(actor: number, number: string, since: number): Promise<Cdr[]>;
  cellAdd(actor: number, name: string, mode: CellMode, group: number): Promise<number>;
  cellSetCert(actor: number, cellId: number, fpr: string): Promise<void>;
  cellRevoke(actor: number, cellId: number): Promise<void>;
  cellStatus(actor: number, cellId?: number): Promise<CellStatus[]>;
  coreStatus(actor: number): Promise<CoreStatus>;
  routeOffer(actor: number, tableVersion: number, blob: Uint8Array, sig: Uint8Array): Promise<void>;
  // ---- the NOC's operations (core v0.4.0; NOC design §7.1). An older core
  // answers each with CoreError 'unsupported'.
  /** Each radio of each linked cell that has reported (one cell, or every cell). */
  cellRadio(actor: number, cellId?: number): Promise<RadioStatus[]>;
  /** Live registrations by number, at most 1000 a call (page with `after`). */
  regList(actor: number, q?: RegListQuery): Promise<Registration[]>;
  /** Call records with id > after, by id, at most `limit` (1–1000). */
  cdrRecent(actor: number, after: number, limit: number): Promise<CdrRecord[]>;
  /** The core's audit records with id > after, by id. */
  auditList(actor: number, q: AuditQuery): Promise<CoreAuditRecord[]>;
  ocssStatus(actor: number): Promise<OcssPeer[]>;
  coreBlocks(actor: number): Promise<CoreBlock[]>;
  /** The mode switch: the cell reconnects in `mode` and its calls end. Idempotent; a revoked cell is 'invalid'. */
  cellMode(actor: number, cellId: number, mode: CellMode): Promise<void>;
}
