// Session attestation — a passkey-signed envelope binding a `SignInResponse`.
//
// `NativeAccountProvider.signIn()` returns an `attestation` string so a consumer
// (cofferdam-api, or any relying party) can cryptographically verify that the
// session it received was authorised by the holder of the account's passkey —
// not forged or replayed by a man-in-the-middle that merely observed an
// `appPseudonym` / `accountAddress`.
//
// The attestation commits (via a keccak256 digest the passkey signs) to the
// security-relevant response fields:
//
//   (scope, appPseudonym, accountAddress, chainId, verified, issuedAt) + (qx, qy)
//
// The signing public key (`qx`/`qy`) is carried in the envelope so a verifier
// can check the signature standalone; the verifier is then expected to confirm
// that key is an active authority on `accountAddress` on-chain (the SDK
// `NativeAccountProvider.listAuthorities()` / the on-chain account registry).
//
// Two signature schemes are supported, discriminated by `alg`, matching the two
// `PasskeySigner` implementations:
//   - `'p256'`     — a raw 64-byte `r || s` over the digest (DeterministicPasskeySigner).
//   - `'webauthn'` — an `abi.encode(WebAuthnAuth)` assertion whose WebAuthn
//                    challenge equals the digest (WebAuthnPasskeySigner / a real
//                    Secure-Enclave / StrongBox passkey).

import { AbiCoder, getBytes, keccak256 } from 'ethers'

import {
  verifyP256Digest,
  type P256PublicKey,
  type PasskeySigner,
  type PasskeySignatureScheme,
} from './passkey.js'
import { base64urlToBytes, bytesToBase64url, verifyWebAuthnAssertion } from './webauthn.js'

const abi = AbiCoder.defaultAbiCoder()

/** Wire-format version of the session-attestation envelope. */
export const SESSION_ATTESTATION_VERSION = 1

/** Token prefix so a consumer can cheaply reject non-Cofferdam attestations. */
const PREFIX = 'csa1:'

/** Domain separator mixed into the signed digest (prevents cross-protocol reuse). */
const DIGEST_DOMAIN = 'cofferdam-session-attestation-v1'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/

/** The `SignInResponse` fields the passkey commits to (everything but the sig). */
export interface SessionAttestationFields {
  /** Consumer-app identifier this session was issued for. */
  scope: string
  /** Per-app stable pseudonym (the consumer's primary user key). */
  appPseudonym: string
  /** ZKSync Era smart-account address governing the session. */
  accountAddress: string
  /** Chain id (260 local / 300 Sepolia / 324 mainnet). */
  chainId: number
  /** Whether the user is Self-verified at issuance. */
  verified: boolean
  /** Unix epoch milliseconds when the attestation was signed (replay bound). */
  issuedAt: number
}

/** A full, self-contained session attestation (the decoded `attestation` string). */
export interface SessionAttestation extends SessionAttestationFields {
  v: number
  /** Signature scheme of `sig` — how a verifier must check it. */
  alg: PasskeySignatureScheme
  /** The passkey public key that produced `sig`. */
  publicKey: P256PublicKey
  /**
   * The passkey signature over `sessionAttestationDigest(fields, publicKey)`.
   * Raw 64-byte `r || s` for `alg === 'p256'`; an `abi.encode(WebAuthnAuth)`
   * assertion for `alg === 'webauthn'`.
   */
  sig: string
}

/** Base class for every session-attestation failure. */
export class SessionAttestationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The token was not a well-formed Cofferdam session attestation. */
export class SessionAttestationDecodeError extends SessionAttestationError {}

/** The attestation is older than `maxAgeMs` (or clock-skewed into the future). */
export class SessionAttestationExpiredError extends SessionAttestationError {}

/** The signature failed, or a presented field did not match `expect`. */
export class SessionAttestationVerificationError extends SessionAttestationError {}

/**
 * The 32-byte digest the passkey signs (and a verifier recomputes). Commits to a
 * domain separator + every attested field + the signing public key, so tampering
 * any field invalidates the signature (and, for WebAuthn, the challenge match).
 */
export function sessionAttestationDigest(
  f: SessionAttestationFields,
  publicKey: P256PublicKey,
): Uint8Array {
  const encoded = abi.encode(
    ['string', 'string', 'string', 'address', 'uint256', 'bool', 'uint64', 'bytes32', 'bytes32'],
    [
      DIGEST_DOMAIN,
      f.scope,
      f.appPseudonym,
      f.accountAddress,
      BigInt(f.chainId),
      f.verified,
      BigInt(f.issuedAt),
      publicKey.qx,
      publicKey.qy,
    ],
  )
  return getBytes(keccak256(encoded))
}

/**
 * Build a signed session attestation. Prompts the passkey (the injected `signer`
 * signs the digest — gating on biometric in production). The signer's public key
 * and scheme are recorded in the envelope so the result verifies standalone.
 */
export async function createSessionAttestation(args: {
  signer: PasskeySigner
  fields: SessionAttestationFields
  publicKey?: P256PublicKey
}): Promise<SessionAttestation> {
  const publicKey = args.publicKey ?? (await args.signer.publicKey())
  const sig = await args.signer.sign(sessionAttestationDigest(args.fields, publicKey))
  return {
    v: SESSION_ATTESTATION_VERSION,
    alg: args.signer.scheme ?? 'p256',
    publicKey,
    ...args.fields,
    sig,
  }
}

/** Serialize an attestation into the compact, prefixed `attestation` token. */
export function encodeSessionAttestation(att: SessionAttestation): string {
  return PREFIX + bytesToBase64url(new TextEncoder().encode(JSON.stringify(att)))
}

/** Convenience: `encodeSessionAttestation(await createSessionAttestation(...))`. */
export async function signSessionAttestation(args: {
  signer: PasskeySigner
  fields: SessionAttestationFields
  publicKey?: P256PublicKey
}): Promise<string> {
  return encodeSessionAttestation(await createSessionAttestation(args))
}

/**
 * Parse an `attestation` token into a structurally-valid `SessionAttestation`.
 * Throws `SessionAttestationDecodeError` on any malformation. Does NOT verify the
 * signature — call `verifySessionAttestation` (or `decodeAndVerifySessionAttestation`).
 */
export function decodeSessionAttestation(token: string): SessionAttestation {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) {
    throw new SessionAttestationDecodeError('[cofferdam-sdk] not a Cofferdam session-attestation token.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(token.slice(PREFIX.length))))
  } catch {
    throw new SessionAttestationDecodeError(
      '[cofferdam-sdk] session-attestation payload is not valid base64url JSON.',
    )
  }
  return assertWellFormed(parsed)
}

/** Fields a verifier may pin so a captured attestation cannot be re-pointed. */
export type SessionAttestationExpectation = Partial<
  Pick<SessionAttestationFields, 'scope' | 'appPseudonym' | 'accountAddress' | 'chainId'>
>

/**
 * Verify a decoded attestation: optional freshness (`maxAgeMs`, 0 to skip) + the
 * optional `expect` field pins + the passkey signature over exactly these fields.
 * Throws on any failure. On success the payload is trustworthy: the holder of
 * `publicKey` signed precisely this `(scope, appPseudonym, accountAddress, …)`.
 *
 * The caller still owns the on-chain authorisation check — confirm `publicKey`
 * is an active authority on `accountAddress` (e.g. via `listAuthorities()`).
 */
export function verifySessionAttestation(
  att: SessionAttestation,
  opts: { expect?: SessionAttestationExpectation; maxAgeMs?: number; now?: number } = {},
): void {
  const maxAgeMs = opts.maxAgeMs ?? 0
  const now = opts.now ?? Date.now()
  if (maxAgeMs > 0 && (now - att.issuedAt > maxAgeMs || att.issuedAt - now > 60_000)) {
    throw new SessionAttestationExpiredError(
      `[cofferdam-sdk] session attestation is stale or clock-skewed (issuedAt=${att.issuedAt}, now=${now}).`,
    )
  }

  const expect = opts.expect
  if (expect) {
    for (const key of ['scope', 'appPseudonym', 'accountAddress', 'chainId'] as const) {
      const want = expect[key]
      if (want === undefined) continue
      const got = att[key]
      const matches =
        key === 'accountAddress'
          ? String(got).toLowerCase() === String(want).toLowerCase()
          : got === want
      if (!matches) {
        throw new SessionAttestationVerificationError(
          `[cofferdam-sdk] session attestation ${key} mismatch (expected ${String(want)}, got ${String(got)}).`,
        )
      }
    }
  }

  const digest = sessionAttestationDigest(att, att.publicKey)
  const ok =
    att.alg === 'webauthn'
      ? verifyWebAuthnAssertion(att.sig, digest, att.publicKey)
      : verifyP256Digest(att.publicKey, digest, att.sig)
  if (!ok) {
    throw new SessionAttestationVerificationError(
      '[cofferdam-sdk] session attestation signature failed: not signed by the presented passkey.',
    )
  }
}

/** Convenience: decode + verify in one call, returning the trusted payload. */
export function decodeAndVerifySessionAttestation(
  token: string,
  opts?: { expect?: SessionAttestationExpectation; maxAgeMs?: number; now?: number },
): SessionAttestation {
  const att = decodeSessionAttestation(token)
  verifySessionAttestation(att, opts)
  return att
}

function assertWellFormed(p: unknown): SessionAttestation {
  if (!p || typeof p !== 'object') {
    throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation payload is not an object.')
  }
  const o = p as Record<string, unknown>
  if (o.v !== SESSION_ATTESTATION_VERSION) {
    throw new SessionAttestationDecodeError(
      `[cofferdam-sdk] unsupported session-attestation version ${String(o.v)} (expected ${SESSION_ATTESTATION_VERSION}).`,
    )
  }
  if (o.alg !== 'p256' && o.alg !== 'webauthn') {
    throw new SessionAttestationDecodeError(`[cofferdam-sdk] unsupported session-attestation alg ${String(o.alg)}.`)
  }
  const pk = o.publicKey as Record<string, unknown> | undefined
  if (!pk || typeof pk.qx !== 'string' || typeof pk.qy !== 'string' || !HEX32_RE.test(pk.qx) || !HEX32_RE.test(pk.qy)) {
    throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation publicKey (qx/qy) is malformed.')
  }
  if (typeof o.scope !== 'string' || o.scope.length === 0) {
    throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation scope is missing.')
  }
  if (typeof o.appPseudonym !== 'string' || o.appPseudonym.length === 0) {
    throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation appPseudonym is missing.')
  }
  if (typeof o.accountAddress !== 'string' || !ADDRESS_RE.test(o.accountAddress)) {
    throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation accountAddress is not an address.')
  }
  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId) || o.chainId <= 0) {
    throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation chainId is missing or invalid.')
  }
  if (typeof o.verified !== 'boolean') {
    throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation verified flag is missing.')
  }
  if (typeof o.issuedAt !== 'number' || !Number.isFinite(o.issuedAt) || o.issuedAt <= 0) {
    throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation issuedAt is missing or invalid.')
  }
  if (typeof o.sig !== 'string' || !o.sig.startsWith('0x')) {
    throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation sig is missing.')
  }
  return {
    v: SESSION_ATTESTATION_VERSION,
    alg: o.alg,
    publicKey: { qx: pk.qx, qy: pk.qy },
    scope: o.scope,
    appPseudonym: o.appPseudonym,
    accountAddress: o.accountAddress,
    chainId: o.chainId,
    verified: o.verified,
    issuedAt: o.issuedAt,
    sig: o.sig,
  }
}
