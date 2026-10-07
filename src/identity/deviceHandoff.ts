// Air-gapped device-handoff QR payload — ARCHITECTURE.md §3.6.4 Step A.
//
// The NEW device renders a QR encoding its passkey public key + a liveness
// proof-of-possession; a LINKED (canonical) device scans it, verifies the
// proof, reviews the label, and submits `addAuthority`
// (`NativeAccountProvider.addBackupPasskey`) to register the new passkey on the
// shared account. This is the same primitive Cofferdam uses for offline,
// same-room device adds at sea (ARCHITECTURE.md §1, fourth statement of intent).
//
// Payload (per §3.6.4 Step A):
//   (credentialId, pubKeyX, pubKeyY, deviceLabel, ts, deviceAccount, livenessSig)
//
// `livenessSig` is the new device's passkey signing the handoff DIGEST — a real
// WebAuthn assertion whose `challenge` equals that digest. The digest commits to
// EVERY field, so a scanned QR cannot be tampered (label/key/account) without
// invalidating the proof. `ts` bounds replay: a canonical device rejects a QR
// older than `maxAgeMs`.
//
// The flow is WebAuthn-native: `livenessSig` is an `abi.encode(WebAuthnAuth)`
// blob (what `WebAuthnPasskeySigner.sign` returns), verified off-chain by
// `verifyWebAuthnAssertion` — the same scheme the on-chain
// `WebAuthnPasskeyAuthority` enforces.

import { AbiCoder, getBytes, keccak256 } from 'ethers'

import type { P256PublicKey, PasskeySigner } from './passkey.js'
import { base64urlToBytes, bytesToBase64url, verifyWebAuthnAssertion } from './webauthn.js'

const abi = AbiCoder.defaultAbiCoder()

/** Wire-format version of the device-handoff payload. */
export const DEVICE_HANDOFF_VERSION = 1

/** Token prefix so a scanner can cheaply reject non-Cofferdam QRs. */
const PREFIX = 'cdh1:'

/** Domain separator mixed into the signed digest. */
const DIGEST_DOMAIN = 'cofferdam-device-handoff-v1'

/** Upper bound on a human device label, so a QR stays scannable. */
export const MAX_DEVICE_LABEL_LENGTH = 64

/** Default freshness window: a scanned QR older than this is rejected. */
export const DEFAULT_HANDOFF_MAX_AGE_MS = 5 * 60_000

/** Allowance for the new device's clock running slightly ahead of the scanner. */
const CLOCK_SKEW_MS = 60_000

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/

/** The fields the new device commits to (everything but the version + signature). */
export interface DeviceHandoffFields {
  /** base64url WebAuthn credential id of the new device's passkey. */
  credentialId: string
  /** The new passkey's P-256 public key — becomes the account authority config. */
  publicKey: P256PublicKey
  /** Human-readable device label, e.g. "Pixel 7" / "Mevlüt's iPad". */
  label: string
  /** Unix epoch milliseconds when the QR was generated (replay bound). */
  ts: number
  /** The new device's own counterfactual AA address (binds the proof to it). */
  deviceAccount: string
}

/** A full, self-contained device-handoff payload (the QR content, decoded). */
export interface DeviceHandoff extends DeviceHandoffFields {
  v: number
  /** WebAuthn assertion (abi.encode(WebAuthnAuth)) over `deviceHandoffDigest`. */
  livenessSig: string
}

/** Base class for every device-handoff failure. */
export class DeviceHandoffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The scanned token was not a well-formed Cofferdam handoff payload. */
export class DeviceHandoffDecodeError extends DeviceHandoffError {}

/** The QR is older than `maxAgeMs` (or clock-skewed into the future). */
export class DeviceHandoffExpiredError extends DeviceHandoffError {}

/** The liveness proof failed: the QR was not signed by the presented passkey. */
export class DeviceHandoffLivenessError extends DeviceHandoffError {}

/**
 * The 32-byte digest the new device signs (and the canonical device recomputes).
 * Commits to a domain separator + every handoff field, so tampering any field
 * breaks the WebAuthn challenge match.
 */
export function deviceHandoffDigest(f: DeviceHandoffFields): Uint8Array {
  const encoded = abi.encode(
    ['string', 'string', 'bytes32', 'bytes32', 'string', 'uint64', 'address'],
    [
      DIGEST_DOMAIN,
      f.credentialId,
      f.publicKey.qx,
      f.publicKey.qy,
      f.label,
      BigInt(f.ts),
      f.deviceAccount,
    ],
  )
  return getBytes(keccak256(encoded))
}

/**
 * Build a signed handoff payload on the NEW device. Prompts the passkey (the
 * injected `signer` performs the WebAuthn assertion over the digest, gating on
 * biometric in production). The signer's public key is used unless `publicKey`
 * is supplied explicitly.
 */
export async function createDeviceHandoff(args: {
  signer: PasskeySigner
  credentialId: string
  label: string
  deviceAccount: string
  publicKey?: P256PublicKey
  ts?: number
}): Promise<DeviceHandoff> {
  const label = args.label.trim()
  if (!label) {
    throw new DeviceHandoffError('[cofferdam-sdk] device handoff requires a non-empty label.')
  }
  if (label.length > MAX_DEVICE_LABEL_LENGTH) {
    throw new DeviceHandoffError(
      `[cofferdam-sdk] device label exceeds ${MAX_DEVICE_LABEL_LENGTH} characters.`,
    )
  }
  if (!ADDRESS_RE.test(args.deviceAccount)) {
    throw new DeviceHandoffError('[cofferdam-sdk] deviceAccount must be a 20-byte hex address.')
  }
  if (!args.credentialId) {
    throw new DeviceHandoffError('[cofferdam-sdk] device handoff requires a credentialId.')
  }

  const publicKey = args.publicKey ?? (await args.signer.publicKey())
  const ts = args.ts ?? Date.now()
  const fields: DeviceHandoffFields = {
    credentialId: args.credentialId,
    publicKey,
    label,
    ts,
    deviceAccount: args.deviceAccount,
  }
  const livenessSig = await args.signer.sign(deviceHandoffDigest(fields))
  return { v: DEVICE_HANDOFF_VERSION, ...fields, livenessSig }
}

/** Serialize a handoff payload into a compact, prefixed QR token. */
export function encodeDeviceHandoff(handoff: DeviceHandoff): string {
  return PREFIX + bytesToBase64url(new TextEncoder().encode(JSON.stringify(handoff)))
}

/**
 * Parse a scanned QR token into a structurally-valid `DeviceHandoff`. Throws
 * `DeviceHandoffDecodeError` on any malformation. Does NOT verify the liveness
 * proof — call `verifyDeviceHandoff` (or `decodeAndVerifyDeviceHandoff`).
 */
export function decodeDeviceHandoff(token: string): DeviceHandoff {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) {
    throw new DeviceHandoffDecodeError('[cofferdam-sdk] not a Cofferdam device-handoff token.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(token.slice(PREFIX.length))))
  } catch {
    throw new DeviceHandoffDecodeError(
      '[cofferdam-sdk] device-handoff payload is not valid base64url JSON.',
    )
  }
  return assertWellFormed(parsed)
}

/**
 * Verify a decoded handoff: freshness (`maxAgeMs`, set 0 to skip) + the WebAuthn
 * liveness proof that the presented passkey signed exactly these fields. Throws
 * `DeviceHandoffExpiredError` / `DeviceHandoffLivenessError` on failure.
 */
export function verifyDeviceHandoff(
  handoff: DeviceHandoff,
  opts: { maxAgeMs?: number; now?: number } = {},
): void {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_HANDOFF_MAX_AGE_MS
  const now = opts.now ?? Date.now()
  if (maxAgeMs > 0 && (now - handoff.ts > maxAgeMs || handoff.ts - now > CLOCK_SKEW_MS)) {
    throw new DeviceHandoffExpiredError(
      `[cofferdam-sdk] device-handoff QR is stale or clock-skewed (ts=${handoff.ts}, now=${now}).`,
    )
  }
  if (!verifyWebAuthnAssertion(handoff.livenessSig, deviceHandoffDigest(handoff), handoff.publicKey)) {
    throw new DeviceHandoffLivenessError(
      '[cofferdam-sdk] device-handoff liveness proof failed: the QR was not signed by the presented passkey.',
    )
  }
}

/** Convenience: decode + verify in one call, returning the trusted payload. */
export function decodeAndVerifyDeviceHandoff(
  token: string,
  opts?: { maxAgeMs?: number; now?: number },
): DeviceHandoff {
  const handoff = decodeDeviceHandoff(token)
  verifyDeviceHandoff(handoff, opts)
  return handoff
}

function assertWellFormed(p: unknown): DeviceHandoff {
  if (!p || typeof p !== 'object') {
    throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff payload is not an object.')
  }
  const o = p as Record<string, unknown>
  if (o.v !== DEVICE_HANDOFF_VERSION) {
    throw new DeviceHandoffDecodeError(
      `[cofferdam-sdk] unsupported device-handoff version ${String(o.v)} (expected ${DEVICE_HANDOFF_VERSION}).`,
    )
  }
  if (typeof o.credentialId !== 'string' || o.credentialId.length === 0) {
    throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff credentialId is missing.')
  }
  const pk = o.publicKey as Record<string, unknown> | undefined
  if (!pk || typeof pk.qx !== 'string' || typeof pk.qy !== 'string' || !HEX32_RE.test(pk.qx) || !HEX32_RE.test(pk.qy)) {
    throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff publicKey (qx/qy) is malformed.')
  }
  if (typeof o.label !== 'string' || o.label.length === 0 || o.label.length > MAX_DEVICE_LABEL_LENGTH) {
    throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff label is missing or too long.')
  }
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts) || o.ts <= 0) {
    throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff ts is missing or invalid.')
  }
  if (typeof o.deviceAccount !== 'string' || !ADDRESS_RE.test(o.deviceAccount)) {
    throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff deviceAccount is not an address.')
  }
  if (typeof o.livenessSig !== 'string' || !o.livenessSig.startsWith('0x')) {
    throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff livenessSig is missing.')
  }
  return {
    v: DEVICE_HANDOFF_VERSION,
    credentialId: o.credentialId,
    publicKey: { qx: pk.qx, qy: pk.qy },
    label: o.label,
    ts: o.ts,
    deviceAccount: o.deviceAccount,
    livenessSig: o.livenessSig,
  }
}
