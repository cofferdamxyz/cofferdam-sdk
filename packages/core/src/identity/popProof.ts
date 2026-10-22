// Per-request proof of possession for `csa1:` v2 (workspace decision 0055), in
// the shape of RFC 9449 (DPoP): a compact JWS the device key signs for each
// request, sent as `DPoP: <proof>` beside `Authorization: DPoP csa1:…`.
//
//   header  {"typ":"dpop+jwt","alg":"ES256","jwk":{"kty":"EC","crv":"P-256","x","y"}}
//   payload {"htm","htu","iat","jti","ath"}
//   signature: ES256 over SHA-256(base64url(header) "." base64url(payload)), raw r||s
//
// `ath` is base64url(SHA-256(token)), so a proof made for one token cannot be
// paired with another. The verifier's replay cache (the plane's `PopReplayDO`)
// is what makes each `jti` single-use; this module only checks a proof.
//
// MUST stay byte-compatible with `cofferdam-api/src/services/sessionAttestation.ts`.

import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { utf8ToBytes } from '@noble/hashes/utils'
import { concat, getBytes, hexlify } from 'ethers'

import { jwkThumbprint, p256FromJwk, p256Jwk, randomBase64url, type DeviceKeySigner } from './deviceKey.js'
import { base64urlToBytes, bytesToBase64url } from './webauthn.js'

/** How far a proof's `iat` may sit from the verifier's clock, in seconds. */
export const POP_MAX_SKEW_S = 60

/** The JWS `typ` of a proof. */
export const POP_TYP = 'dpop+jwt'

const JTI_RE = /^[A-Za-z0-9_-]{16,64}$/

/** The claims a proof signs. */
export interface PopProofClaims {
  /** The request's HTTP method, upper case. */
  htm: string
  /** The request URL without query or fragment (`popHtu`). */
  htu: string
  /** Unix seconds when the proof was made. */
  iat: number
  /** A random identifier the verifier accepts only once. */
  jti: string
  /** base64url(SHA-256(token)) of the session attestation it accompanies. */
  ath: string
}

/** A proof that failed to decode or verify. */
export class PopProofError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PopProofError'
  }
}

function b64urlJson(value: unknown): string {
  return bytesToBase64url(utf8ToBytes(JSON.stringify(value)))
}

/** The URL a proof names: origin and path, without query or fragment. */
export function popHtu(url: string): string {
  const u = new URL(url)
  return `${u.origin}${u.pathname}`
}

/** `ath` for a token: base64url(SHA-256(token)). */
export function popAth(token: string): string {
  return bytesToBase64url(sha256(utf8ToBytes(token)))
}

/** `s` forced into the lower half-order, so every verifier accepts the signature. */
function normaliseLowS(rs: Uint8Array): Uint8Array {
  if (rs.length !== 64) throw new PopProofError('[cofferdam-sdk] a device-key signature is 64 bytes (r || s).')
  const n = p256.CURVE.n
  let s = BigInt(hexlify(rs.slice(32)))
  if (s > n / 2n) s = n - s
  const out = new Uint8Array(64)
  out.set(rs.slice(0, 32), 0)
  out.set(getBytes('0x' + s.toString(16).padStart(64, '0')), 32)
  return out
}

/**
 * Make the proof for one request. `htu` may be the full request URL: its query
 * and fragment are dropped. `now` is Unix milliseconds.
 */
export async function createPopProof(args: {
  deviceKey: DeviceKeySigner
  htm: string
  htu: string
  token: string
  now?: number
  jti?: string
}): Promise<string> {
  const pub = await args.deviceKey.publicKey()
  const header = { typ: POP_TYP, alg: 'ES256', jwk: p256Jwk(pub) }
  const payload: PopProofClaims = {
    htm: args.htm.toUpperCase(),
    htu: popHtu(args.htu),
    iat: Math.floor((args.now ?? Date.now()) / 1000),
    jti: args.jti ?? randomBase64url(16),
    ath: popAth(args.token),
  }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
  const sig = normaliseLowS(getBytes(await args.deviceKey.sign(sha256(utf8ToBytes(signingInput)))))
  return `${signingInput}.${bytesToBase64url(sig)}`
}

/**
 * Check a proof against the request and the token it accompanies. Returns the
 * thumbprint of the key that signed it and its `jti`; the caller compares the
 * thumbprint with the token's `cnf.jkt` and records the `jti`.
 */
export function verifyPopProof(
  proof: string,
  expect: { token: string; htm: string; htu: string; now?: number; maxSkewS?: number },
): { jkt: string; jti: string; iat: number } {
  const parts = typeof proof === 'string' ? proof.split('.') : []
  if (parts.length !== 3) throw new PopProofError('[cofferdam-sdk] a proof is a compact JWS (three parts).')
  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[0]!)))
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[1]!)))
  } catch {
    throw new PopProofError('[cofferdam-sdk] proof header or payload is not base64url JSON.')
  }
  if (header.typ !== POP_TYP || header.alg !== 'ES256') {
    throw new PopProofError('[cofferdam-sdk] proof must be typ dpop+jwt, alg ES256.')
  }
  let pub
  try {
    pub = p256FromJwk(header.jwk)
  } catch (err) {
    throw new PopProofError((err as Error).message)
  }
  const sig = base64urlToBytes(parts[2]!)
  const digest = sha256(utf8ToBytes(`${parts[0]}.${parts[1]}`))
  const point = getBytes(concat(['0x04', pub.qx, pub.qy]))
  let valid = false
  try {
    valid = sig.length === 64 && p256.verify(sig, digest, point, { lowS: false })
  } catch {
    valid = false
  }
  if (!valid) throw new PopProofError('[cofferdam-sdk] proof signature failed.')

  const { htm, htu, iat, jti, ath } = payload
  if (typeof htm !== 'string' || htm !== expect.htm.toUpperCase()) {
    throw new PopProofError('[cofferdam-sdk] proof htm does not match the request method.')
  }
  if (typeof htu !== 'string' || htu !== popHtu(expect.htu)) {
    throw new PopProofError('[cofferdam-sdk] proof htu does not match the request URL.')
  }
  const nowS = Math.floor((expect.now ?? Date.now()) / 1000)
  const skew = expect.maxSkewS ?? POP_MAX_SKEW_S
  if (typeof iat !== 'number' || !Number.isInteger(iat) || Math.abs(nowS - iat) > skew) {
    throw new PopProofError('[cofferdam-sdk] proof iat is missing or outside the allowed window.')
  }
  if (typeof jti !== 'string' || !JTI_RE.test(jti)) {
    throw new PopProofError('[cofferdam-sdk] proof jti must be 16 to 64 base64url characters.')
  }
  if (typeof ath !== 'string' || ath !== popAth(expect.token)) {
    throw new PopProofError('[cofferdam-sdk] proof ath does not match the session token.')
  }
  return { jkt: jwkThumbprint(pub), jti, iat }
}
