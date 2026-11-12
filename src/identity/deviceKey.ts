// Device keys for `csa1:` v2 sessions (workspace decision 0055).
//
// A device key is a P-256 key the client holds and cannot export: the Secure
// Enclave or the Android Keystore in the Cofferdam app, a non-extractable
// WebCrypto key in a browser. A v2 session attestation names it by its RFC 7638
// thumbprint (`cnf.jkt`), and the device key then signs a proof for every
// request (`identity/popProof.ts`), so a copied token is worthless without the
// device. The app mints a fresh key at every passkey assertion.
//
// The SDK never touches the key itself: callers inject a `DeviceKeySigner`.
// Hashing stays on `@noble/hashes` (Hermes has no WebCrypto).

import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils'
import { getBytes, hexlify } from 'ethers'

import type { P256PublicKey } from './passkey.js'
import { base64urlToBytes, bytesToBase64url } from './webauthn.js'

/**
 * The signing seam for a device key. `sign` receives a 32-byte digest and
 * returns a 0x-prefixed 64-byte `r || s` (either half-order of `s` is accepted;
 * `createPopProof` normalises it).
 */
export interface DeviceKeySigner {
  /** The device key's public point. */
  publicKey(): Promise<P256PublicKey>
  /** Sign a 32-byte digest, returning a 0x-prefixed 64-byte `r || s`. */
  sign(digest: Uint8Array): Promise<string>
}

/** A P-256 public JWK carrying exactly the members RFC 7638 hashes. */
export interface P256Jwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

/** The public JWK of a P-256 point (base64url coordinates, no padding). */
export function p256Jwk(pub: P256PublicKey): P256Jwk {
  return { kty: 'EC', crv: 'P-256', x: bytesToBase64url(getBytes(pub.qx)), y: bytesToBase64url(getBytes(pub.qy)) }
}

/** The P-256 point of a public JWK. Throws on anything but a 32-byte-coordinate P-256 key. */
export function p256FromJwk(jwk: unknown): P256PublicKey {
  const j = jwk as Record<string, unknown> | null
  if (!j || j.kty !== 'EC' || j.crv !== 'P-256' || typeof j.x !== 'string' || typeof j.y !== 'string') {
    throw new Error('[cofferdam-sdk] not a P-256 public JWK.')
  }
  if ('d' in j) throw new Error('[cofferdam-sdk] a public JWK must not carry the private key.')
  const x = base64urlToBytes(j.x)
  const y = base64urlToBytes(j.y)
  if (x.length !== 32 || y.length !== 32) throw new Error('[cofferdam-sdk] P-256 JWK coordinates must be 32 bytes.')
  return { qx: hexlify(x), qy: hexlify(y) }
}

/**
 * RFC 7638 thumbprint of a P-256 public key: base64url(SHA-256) of the JWK's
 * required members in lexicographic order with no whitespace. 43 characters.
 */
export function jwkThumbprint(pub: P256PublicKey): string {
  const jwk = p256Jwk(pub)
  const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
  return bytesToBase64url(sha256(utf8ToBytes(canonical)))
}

/**
 * An in-memory device key for tests, servers and tooling. Its private key lives
 * in JavaScript memory, so it is NOT a substitute for the Secure Enclave or the
 * Keystore in an app.
 */
export class SoftwareDeviceKeySigner implements DeviceKeySigner {
  readonly #privateKey: Uint8Array

  constructor(privateKey: Uint8Array) {
    if (privateKey.length !== 32) throw new Error('[cofferdam-sdk] a P-256 private key is 32 bytes.')
    this.#privateKey = privateKey
  }

  /** A fresh random key. */
  static generate(): SoftwareDeviceKeySigner {
    return new SoftwareDeviceKeySigner(p256.utils.randomPrivateKey())
  }

  async publicKey(): Promise<P256PublicKey> {
    const pub = p256.getPublicKey(this.#privateKey, false)
    return { qx: hexlify(pub.slice(1, 33)), qy: hexlify(pub.slice(33, 65)) }
  }

  async sign(digest: Uint8Array): Promise<string> {
    const sig = p256.sign(digest, this.#privateKey)
    return '0x' + sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0')
  }
}

/** A random base64url identifier of `bytes` bytes (the proof `jti`). */
export function randomBase64url(bytes = 16): string {
  return bytesToBase64url(randomBytes(bytes))
}
