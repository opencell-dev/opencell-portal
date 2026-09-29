// The core admin API as the portal sees it (portal spec §7). P1 implements it
// with FakeCore (in-process); P4 adds the mTLS client for oc-core's port 7444.
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
  | 'unavailable';

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}

export interface CoreAdmin {
  /** Up to `count` (1–32) random free numbers in an exchange (+8831NPANXX);
   *  `pattern` is 5 characters of digits and `x` over the last five digits. */
  numFree(actor: number, exchange: string, count: number, pattern?: string): Promise<string[]>;
  numCheck(actor: number, number: string): Promise<NumCheck>;
  subCreate(actor: number, number: string): Promise<IssuedToken>;
  subReissue(actor: number, number: string): Promise<IssuedToken>;
  subStatus(actor: number, number: string): Promise<SubStatus>;
  /** Only an unactivated number can be released (CoreError not_unactivated). */
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
