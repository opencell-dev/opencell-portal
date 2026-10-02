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
}
