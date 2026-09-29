import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { type CBORType, encodeCBOR } from '@levischuck/tiny-cbor';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

interface Cred {
  id: Buffer;
  key: KeyObject;
  userHandle: string;
  count: number;
}

/**
 * A software passkey authenticator (ES256, "none" attestation) for Node
 * tests, so registration and sign-in run through SimpleWebAuthn's real
 * verification. Playwright uses Chromium's virtual authenticator instead.
 */
export class SoftAuthenticator {
  readonly creds: Cred[] = [];

  constructor(private readonly origin: string) {}

  private authData(rpId: string, flags: number, count: number, attested?: Buffer): Buffer {
    const head = Buffer.alloc(37);
    sha256(rpId).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(count, 33);
    return attested ? Buffer.concat([head, attested]) : head;
  }

  create(options: PublicKeyCredentialCreationOptionsJSON): RegistrationResponseJSON {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = encodeCBOR(
      new Map<number, CBORType>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const id = randomBytes(16);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(id.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, id, Buffer.from(cose)]);
    const authData = this.authData(options.rp.id!, 0x01 | 0x04 | 0x40, 0, attested);
    const attestationObject = encodeCBOR(
      new Map<string, CBORType>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false });
    this.creds.push({ id, key: privateKey, userHandle: options.user.id, count: 0 });
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(Buffer.from(clientDataJSON)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Assert with the credential `which` (default: the newest), as a discoverable passkey would. */
  get(options: PublicKeyCredentialRequestOptionsJSON, which = this.creds.length - 1): AuthenticationResponseJSON {
    const c = this.creds[which];
    c.count += 1;
    const authData = this.authData(options.rpId!, 0x01 | 0x04, c.count);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), c.key);
    return {
      id: b64u(c.id),
      rawId: b64u(c.id),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: c.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
