// WebAuthn passkey signing for the Base ERC-4337 Account Abstraction stack.
//
// This is the REAL-passkey counterpart to `passkey.ts`'s software signer. The
// on-chain `WebAuthnPasskeyAuthority` (contracts/v2/auth/authorities/
// WebAuthnPasskeyAuthority.sol) verifies a full WebAuthn assertion via
// OpenZeppelin's `WebAuthn` library:
//   - config    = abi.encode(bytes32 qx, bytes32 qy)            — the passkey pubkey.
//   - signature = abi.encode(WebAuthn.WebAuthnAuth) i.e.
//                 (bytes32 r, bytes32 s, uint256 challengeIndex,
//                  uint256 typeIndex, bytes authenticatorData, string clientDataJSON)
//   - the WebAuthn *challenge* MUST equal the 32-byte account tx digest.
//
// This module is platform-agnostic: it knows how to turn a W3C
// `AuthenticatorAssertionResponse` (base64url `authenticatorData` /
// `clientDataJSON` / DER `signature`) into that `WebAuthnAuth` blob, and how to
// recover `qx/qy` from a DER SubjectPublicKeyInfo. The actual ceremony
// (`navigator.credentials` in the browser, `react-native-passkeys` on device)
// is injected as a `WebAuthnAuthenticator`, so this file never imports a
// platform SDK.

import { p256 } from '@noble/curves/p256'
import { AbiCoder, concat, getBytes, hexlify, sha256 } from 'ethers'

import {
  encodePasskeyConfig,
  type P256PublicKey,
  type PasskeySigner,
  type PasskeySignatureScheme,
} from './passkey.js'

const abi = AbiCoder.defaultAbiCoder()

/** A single WebAuthn assertion, as returned by a platform authenticator. Each
 *  field may be a base64url string (the raw `react-native-passkeys` / browser
 *  shape) or already-decoded bytes; `clientDataJSON` may also be the raw JSON. */
export interface WebAuthnAssertion {
  /** `response.authenticatorData` — base64url string or bytes. */
  authenticatorData: string | Uint8Array
  /** `response.clientDataJSON` — base64url string, raw JSON string, or bytes. */
  clientDataJSON: string | Uint8Array
  /** `response.signature` — ASN.1 DER ECDSA, base64url string or bytes. */
  signature: string | Uint8Array
}

/**
 * The injected ceremony seam. An implementation performs a WebAuthn assertion
 * (`get`) over `challenge` (the 32-byte tx digest) and returns the response.
 * The browser/native adapter is responsible for selecting the right credential
 * and prompting the user (biometric).
 */
export interface WebAuthnAuthenticator {
  authenticate(challenge: Uint8Array): Promise<WebAuthnAssertion>
}

// ── base64url ────────────────────────────────────────────────────────────────

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Decode a base64url (or base64) string to bytes. Portable: no atob/Buffer. */
export function base64urlToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9\-_+/]/g, '')
  const lookup = new Int16Array(256).fill(-1)
  for (let i = 0; i < B64_ALPHABET.length; i++) lookup[B64_ALPHABET.charCodeAt(i)] = i
  lookup['+'.charCodeAt(0)] = 62
  lookup['/'.charCodeAt(0)] = 63
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const v = lookup[clean.charCodeAt(i)]
    if (v < 0) continue
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

/** Encode bytes to base64url (no padding). Portable. */
export function bytesToBase64url(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i]!
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += B64_ALPHABET[(buffer >> bits) & 0x3f]
    }
  }
  if (bits > 0) out += B64_ALPHABET[(buffer << (6 - bits)) & 0x3f]
  return out
}

// ── Key + signature decoding ──────────────────────────────────────────────────

/**
 * Recover `{qx, qy}` from a DER-encoded SubjectPublicKeyInfo (the
 * `response.publicKey` a platform returns at registration for an ES256 key).
 * For P-256 the uncompressed point `0x04 || X(32) || Y(32)` is the trailing 65
 * bytes of the SPKI; we extract and validate it on-curve via @noble.
 */
export function p256PublicKeyFromDer(der: string | Uint8Array): P256PublicKey {
  const bytes = typeof der === 'string' ? base64urlToBytes(der) : der
  if (bytes.length < 65) {
    throw new Error('[cofferdam-sdk] WebAuthn public key DER too short to hold a P-256 point.')
  }
  const point = bytes.slice(bytes.length - 65)
  if (point[0] !== 0x04) {
    throw new Error('[cofferdam-sdk] Unexpected WebAuthn public key encoding (no 0x04 point prefix).')
  }
  // Validates the point is on secp256r1; throws otherwise.
  p256.ProjectivePoint.fromHex(point)
  return { qx: hexlify(point.slice(1, 33)), qy: hexlify(point.slice(33, 65)) }
}

/** Parse an ASN.1 DER ECDSA signature into low-s-normalised 32-byte r and s. */
export function derSignatureToRS(der: string | Uint8Array): { r: string; s: string } {
  const bytes = typeof der === 'string' ? base64urlToBytes(der) : der
  const sig = p256.Signature.fromDER(bytes)
  const n = p256.CURVE.n
  let s = sig.s
  if (s > n / 2n) s = n - s
  return {
    r: '0x' + sig.r.toString(16).padStart(64, '0'),
    s: '0x' + s.toString(16).padStart(64, '0'),
  }
}

function toClientDataJSONString(v: string | Uint8Array): string {
  if (typeof v !== 'string') return new TextDecoder().decode(v)
  // A raw clientDataJSON always starts with '{'. Otherwise treat as base64url.
  if (v.trimStart().startsWith('{')) return v
  return new TextDecoder().decode(base64urlToBytes(v))
}

function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === 'string' ? base64urlToBytes(v) : v
}

/**
 * Encode a WebAuthn assertion into the `abi.encode(WebAuthn.WebAuthnAuth)` blob
 * the on-chain authority decodes. Computes `typeIndex` / `challengeIndex` from
 * the clientDataJSON and DER-decodes the signature to low-s r/s.
 */
export function encodeWebAuthnInnerSignature(assertion: WebAuthnAssertion): string {
  const clientDataJSON = toClientDataJSONString(assertion.clientDataJSON)
  const authenticatorData = toBytes(assertion.authenticatorData)
  const { r, s } = derSignatureToRS(assertion.signature)

  const typeIndex = clientDataJSON.indexOf('"type":')
  const challengeIndex = clientDataJSON.indexOf('"challenge":')
  if (typeIndex < 0 || challengeIndex < 0) {
    throw new Error('[cofferdam-sdk] clientDataJSON missing "type"/"challenge" fields.')
  }

  return abi.encode(
    ['bytes32', 'bytes32', 'uint256', 'uint256', 'bytes', 'string'],
    [r, s, challengeIndex, typeIndex, hexlify(authenticatorData), clientDataJSON],
  )
}

/** A decoded `WebAuthn.WebAuthnAuth` blob (the inverse of `encodeWebAuthnInnerSignature`). */
export interface DecodedWebAuthnAuth {
  r: string
  s: string
  challengeIndex: number
  typeIndex: number
  authenticatorData: Uint8Array
  clientDataJSON: string
}

/** Decode an `abi.encode(WebAuthn.WebAuthnAuth)` blob back into its fields. */
export function decodeWebAuthnInnerSignature(blob: string): DecodedWebAuthnAuth {
  const [r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON] = abi.decode(
    ['bytes32', 'bytes32', 'uint256', 'uint256', 'bytes', 'string'],
    blob,
  ) as unknown as [string, string, bigint, bigint, string, string]
  return {
    r,
    s,
    challengeIndex: Number(challengeIndex),
    typeIndex: Number(typeIndex),
    authenticatorData: getBytes(authenticatorData),
    clientDataJSON,
  }
}

/**
 * Off-chain mirror of the on-chain `WebAuthnPasskeyAuthority` check: verify that
 * `blob` is a WebAuthn assertion by `pub` over `expectedChallenge` (the 32-byte
 * digest). Confirms `type == "webauthn.get"`, the embedded `challenge` equals
 * `base64url(expectedChallenge)`, and the P-256 signature over
 * `sha256(authenticatorData || sha256(clientDataJSON))` validates against `pub`.
 * Returns false (never throws) on any malformed input or mismatch.
 */
export function verifyWebAuthnAssertion(
  blob: string,
  expectedChallenge: Uint8Array,
  pub: P256PublicKey,
): boolean {
  let auth: DecodedWebAuthnAuth
  try {
    auth = decodeWebAuthnInnerSignature(blob)
  } catch {
    return false
  }

  let parsed: { type?: unknown; challenge?: unknown }
  try {
    parsed = JSON.parse(auth.clientDataJSON) as { type?: unknown; challenge?: unknown }
  } catch {
    return false
  }
  if (parsed.type !== 'webauthn.get') return false
  if (parsed.challenge !== bytesToBase64url(getBytes(expectedChallenge))) return false

  const clientDataHash = getBytes(sha256(new TextEncoder().encode(auth.clientDataJSON)))
  const signedBase = new Uint8Array(auth.authenticatorData.length + clientDataHash.length)
  signedBase.set(auth.authenticatorData, 0)
  signedBase.set(clientDataHash, auth.authenticatorData.length)
  const messageHash = getBytes(sha256(signedBase))

  try {
    const sig = getBytes(concat([auth.r, auth.s]))
    const point = getBytes(concat(['0x04', pub.qx, pub.qy]))
    return p256.verify(sig, messageHash, point)
  } catch {
    return false
  }
}

// ── Signer ─────────────────────────────────────────────────────────────────

/**
 * A `PasskeySigner` backed by a real WebAuthn authenticator. The public key is
 * captured once at enrolment (`p256PublicKeyFromDer(create().response.publicKey)`)
 * and stored as the account's authority config; `sign()` performs an assertion
 * over the tx digest and returns the `WebAuthnAuth` blob the
 * `WebAuthnPasskeyAuthority` expects as `innerSignature`.
 *
 * Note the returned `sign()` value is NOT a bare 64-byte r||s (as in the
 * software `DeterministicPasskeySigner`) — it is the full ABI-encoded assertion.
 * `NativeAccountProvider` is agnostic: it wraps whatever bytes the signer
 * returns as `abi.encode(authorityId, innerSignature)`.
 */
export class WebAuthnPasskeySigner implements PasskeySigner {
  readonly scheme: PasskeySignatureScheme = 'webauthn'

  constructor(
    private readonly pubKey: P256PublicKey,
    private readonly authenticator: WebAuthnAuthenticator,
  ) {}

  async publicKey(): Promise<P256PublicKey> {
    return this.pubKey
  }

  async sign(digest: Uint8Array): Promise<string> {
    const assertion = await this.authenticator.authenticate(getBytes(digest))
    return encodeWebAuthnInnerSignature(assertion)
  }
}

/** Convenience: the account authority config for a WebAuthn pubkey. */
export function webAuthnConfig(pub: P256PublicKey): string {
  return encodePasskeyConfig(pub)
}

// ── Software authenticator (tests / Node) ───────────────────────────────────

/**
 * A software `WebAuthnAuthenticator` that synthesises a valid assertion with a
 * held P-256 key — byte-identical to what a hardware authenticator emits, and
 * to contracts/test/helpers/authority.ts `signWebAuthn`. For tests and local
 * PoC only: there is no biometric gate and the key is in memory.
 *
 * `flags` defaults to UP|UV|BE|BS (0x1d): a synced platform passkey that did UV.
 */
export function softwareWebAuthnAuthenticator(
  privateKey: Uint8Array,
  opts: { rpId?: string; origin?: string; flags?: number } = {},
): WebAuthnAuthenticator {
  const rpId = opts.rpId ?? 'cofferdam.xyz'
  const origin = opts.origin ?? `https://${rpId}`
  const flags = opts.flags ?? 0x1d
  return {
    async authenticate(challenge: Uint8Array): Promise<WebAuthnAssertion> {
      const clientDataJSON =
        `{"type":"webauthn.get","challenge":"${bytesToBase64url(challenge)}",` +
        `"origin":"${origin}","crossOrigin":false}`

      const rpIdHash = getBytes(sha256(new TextEncoder().encode(rpId)))
      const authenticatorData = new Uint8Array(37)
      authenticatorData.set(rpIdHash, 0)
      authenticatorData[32] = flags
      // signCount = 0 (bytes 33..36)

      const clientDataHash = getBytes(sha256(new TextEncoder().encode(clientDataJSON)))
      const base = new Uint8Array(authenticatorData.length + clientDataHash.length)
      base.set(authenticatorData, 0)
      base.set(clientDataHash, authenticatorData.length)
      const messageHash = getBytes(sha256(base))

      const sig = p256.sign(messageHash, privateKey)
      // Return DER, matching what real authenticators emit (the encoder
      // re-normalises s and extracts r/s).
      return {
        authenticatorData,
        clientDataJSON,
        signature: sig.toDERRawBytes(),
      }
    },
  }
}

/** Derive `{qx, qy}` directly from a P-256 private scalar (software-key helper). */
export function softwareWebAuthnPublicKey(privateKey: Uint8Array): P256PublicKey {
  const pub = p256.getPublicKey(privateKey, false)
  return { qx: hexlify(pub.slice(1, 33)), qy: hexlify(pub.slice(33, 65)) }
}
