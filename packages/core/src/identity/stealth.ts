// ERC-5564 scheme 1 stealth addresses on secp256k1 (workspace decision 0086
// rules 1 and 5, under decisions 0059 and 0083).
//
//   meta-address  = S ‖ V, two 33-byte compressed public keys, spending first (66 bytes)
//   payer         r random, R = r·G, s = r·V, h = keccak256(compressed s), view tag = h[0]
//   stealth signer P = S + h·G, its address keccak256(P)[12:]
//   recipient     s = v·R, the same h, private key p = s_spend + h (mod n)
//
// The compressed encoding of s and of the keys is the reference
// implementation's convention (ScopeLift's stealth-address-sdk hashes noble's
// default, compressed, shared secret); ERC-5564's text does not fix it.
//
// An announcement names the one-time account, not its signer (0086 rule 5):
// the account is the counterfactual address a factory gives the signer
// (decision 0083 rule 4). That factory is not designed yet, so the address
// is a function of a factory description the caller passes, from its
// configuration. The shared fixture's placeholder factory is never deployed:
// an account under it can never be spent from.
//
// Synchronous and pure; hashing is @noble/hashes, the curve @noble/curves.

import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { randomBytes } from '@noble/hashes/utils'
import { getAddress, getCreate2Address, hexlify, zeroPadValue } from 'ethers'

/** ERC-5564 scheme id of secp256k1 with view tags, the only scheme Cofferdam uses. */
export const STEALTH_SCHEME_ID = 1

/** Bytes in a scheme 1 meta-address: the spending then the viewing public key, compressed. */
export const META_ADDRESS_BYTES = 66

const N = secp256k1.CURVE.n
const Point = secp256k1.ProjectivePoint

/** A stealth operation refused (a malformed key, or a hash outside the curve order). */
export class StealthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StealthError'
  }
}

/** The two public keys of a scheme 1 meta-address. */
export interface StealthMetaAddress {
  /** S, 33 bytes compressed. */
  spendingPublicKey: Uint8Array
  /** V, 33 bytes compressed. */
  viewingPublicKey: Uint8Array
}

/**
 * How a one-time account's address follows from its signer: a CREATE2
 * factory and the hash of the init code, with the signer left-padded to 32
 * bytes as the salt.
 */
export interface OneTimeAccountFactory {
  /** The factory's address. */
  address: string
  /** keccak256 of the account's init code, 0x-prefixed 32 bytes. */
  initCodeHash: string
}

// ASSUMPTION(0086 Ruling A): one-time accounts come from decision 0083 rule
// 4's factory, which does not exist yet. The account address is therefore a
// function of a factory the caller passes; the SDK ships no factory address.
// The tests and the shared fixture use a never-deployed placeholder
// (`test/fixtures/oneTimeFactory.ts`, and `stealth.factory` in
// `handleAnchorTypes.json` for the plane and the contract).

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n
}

function bigIntTo32(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function asScalar(name: string, key: Uint8Array): bigint {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new StealthError(`stealth: the ${name} must be 32 bytes`)
  }
  const k = bytesToBigInt(key)
  if (k === 0n || k >= N) throw new StealthError(`stealth: the ${name} is not a valid secp256k1 key`)
  return k
}

function asPoint(name: string, key: Uint8Array) {
  if (!(key instanceof Uint8Array) || key.length !== 33) {
    throw new StealthError(`stealth: the ${name} must be a 33-byte compressed public key`)
  }
  try {
    return Point.fromHex(key)
  } catch {
    throw new StealthError(`stealth: the ${name} is not a point on secp256k1`)
  }
}

/** The Ethereum address of a secp256k1 point, checksummed. */
function pointAddress(p: InstanceType<typeof Point>): string {
  const uncompressed = p.toRawBytes(false)
  return getAddress(hexlify(keccak_256(uncompressed.slice(1)).slice(12)))
}

/**
 * The address of a secp256k1 private key, checksummed.
 *
 * @param privateKey - 32 bytes, 0 < k < n.
 */
export function secp256k1Address(privateKey: Uint8Array): string {
  return pointAddress(Point.BASE.multiply(asScalar('private key', privateKey)))
}

/**
 * The scalar a 32-byte HKDF output gives: the value reduced mod the curve
 * order, 0 refused (decision 0086 rule 1).
 *
 * @param material - 32 bytes of key material.
 * @returns A valid 32-byte secp256k1 private key.
 */
export function secp256k1KeyFromMaterial(material: Uint8Array): Uint8Array {
  if (!(material instanceof Uint8Array) || material.length !== 32) {
    throw new StealthError('stealth: key material must be 32 bytes')
  }
  const k = bytesToBigInt(material) % N
  if (k === 0n) throw new StealthError('stealth: the key material reduces to zero')
  return bigIntTo32(k)
}

/**
 * The 66-byte scheme 1 meta-address of two compressed public keys.
 *
 * @param spendingPublicKey - S, 33 bytes.
 * @param viewingPublicKey - V, 33 bytes.
 */
export function encodeMetaAddress(spendingPublicKey: Uint8Array, viewingPublicKey: Uint8Array): Uint8Array {
  asPoint('spending public key', spendingPublicKey)
  asPoint('viewing public key', viewingPublicKey)
  const out = new Uint8Array(META_ADDRESS_BYTES)
  out.set(spendingPublicKey, 0)
  out.set(viewingPublicKey, 33)
  return out
}

/**
 * The two keys of a scheme 1 meta-address, each checked to be on the curve.
 *
 * @param metaAddress - 66 bytes, or their 0x-prefixed hex.
 * @throws StealthError when the length or either point is wrong.
 */
export function decodeMetaAddress(metaAddress: Uint8Array | string): StealthMetaAddress {
  const bytes = typeof metaAddress === 'string' ? hexToBytes(metaAddress) : metaAddress
  if (!(bytes instanceof Uint8Array) || bytes.length !== META_ADDRESS_BYTES) {
    throw new StealthError(`stealth: a meta-address is ${META_ADDRESS_BYTES} bytes`)
  }
  const spendingPublicKey = bytes.slice(0, 33)
  const viewingPublicKey = bytes.slice(33)
  asPoint('spending public key', spendingPublicKey)
  asPoint('viewing public key', viewingPublicKey)
  return { spendingPublicKey, viewingPublicKey }
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new StealthError('stealth: expected 0x-prefixed hex')
  const out = new Uint8Array((hex.length - 2) / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16)
  return out
}

/** h = keccak256 of the compressed shared point, checked to be a usable scalar. */
function hashSharedSecret(shared: Uint8Array): { h: Uint8Array; hn: bigint } {
  const h = keccak_256(shared)
  const hn = bytesToBigInt(h)
  // The reference implementation multiplies G by h as is, which fails for
  // h = 0 or h >= n; refusing those keeps every Cofferdam side in step with it.
  if (hn === 0n || hn >= N) throw new StealthError('stealth: the shared-secret hash is outside the curve order')
  return { h, hn }
}

/**
 * The stealth signer P = S + h·G for a spending key and a shared-secret hash:
 * what the plane's `addresses` route checks (0086 rule 5), with no ephemeral
 * secret and no viewing key.
 *
 * @param spendingPublicKey - S, 33 bytes.
 * @param sharedSecretHash - h, 32 bytes.
 * @returns The signer's checksummed address.
 */
export function stealthSignerFromHash(spendingPublicKey: Uint8Array, sharedSecretHash: Uint8Array): string {
  const S = asPoint('spending public key', spendingPublicKey)
  if (!(sharedSecretHash instanceof Uint8Array) || sharedSecretHash.length !== 32) {
    throw new StealthError('stealth: the shared-secret hash must be 32 bytes')
  }
  const hn = bytesToBigInt(sharedSecretHash)
  if (hn === 0n || hn >= N) throw new StealthError('stealth: the shared-secret hash is outside the curve order')
  return pointAddress(S.add(Point.BASE.multiply(hn)))
}

/**
 * The one-time account a factory gives a stealth signer (CREATE2, the signer
 * left-padded to 32 bytes as the salt). The address an announcement names.
 *
 * @param signer - The stealth signer's address.
 * @param factory - The factory, from the caller's configuration (decision 0083 rule 4).
 * @returns The account's checksummed address.
 */
export function oneTimeAccountAddress(signer: string, factory: OneTimeAccountFactory): string {
  return getCreate2Address(getAddress(factory.address), zeroPadValue(getAddress(signer), 32), factory.initCodeHash)
}

/** A one-time address derived for a payment, and what its announcement carries. */
export interface GeneratedStealthAddress {
  /** The one-time account (`oneTimeAccountAddress` of the signer): the announcement's `stealthAddress`. */
  account: string
  /** The stealth signer P = S + h·G. */
  signer: string
  /** R = r·G, 33 bytes compressed. */
  ephemeralPublicKey: Uint8Array
  /** h[0], the first byte of the announcement's metadata. */
  viewTag: number
  /** h, 32 bytes: per address, kept encrypted by the plane when registered (0083 R10). */
  sharedSecretHash: Uint8Array
}

/**
 * Derive a one-time address from a meta-address (the payer's side, or the
 * user's own phone with a self-derived ephemeral key).
 *
 * @param metaAddress - The 66-byte meta-address, checked against the anchor first.
 * @param factory - The one-time account factory.
 * @param ephemeralPrivateKey - r, 32 bytes; a fresh random one when omitted.
 *   The caller drops it once the payment is built.
 * @throws StealthError on a malformed meta-address or key, and in the
 *   2^-128 case where h falls outside the curve order (pick another r).
 */
export function generateStealthAddress(
  metaAddress: Uint8Array | string,
  factory: OneTimeAccountFactory,
  ephemeralPrivateKey?: Uint8Array,
): GeneratedStealthAddress {
  const { spendingPublicKey, viewingPublicKey } = decodeMetaAddress(metaAddress)
  let r: Uint8Array
  if (ephemeralPrivateKey === undefined) {
    do r = randomBytes(32)
    while (bytesToBigInt(r) === 0n || bytesToBigInt(r) >= N)
  } else {
    asScalar('ephemeral private key', ephemeralPrivateKey)
    r = ephemeralPrivateKey
  }
  const shared = secp256k1.getSharedSecret(r, viewingPublicKey, true)
  const { h } = hashSharedSecret(shared)
  const signer = stealthSignerFromHash(spendingPublicKey, h)
  return {
    account: oneTimeAccountAddress(signer, factory),
    signer,
    ephemeralPublicKey: secp256k1.getPublicKey(r, true),
    viewTag: h[0]!,
    sharedSecretHash: h,
  }
}

/** What an ERC-5564 announcement carries that a scan reads. */
export interface StealthAnnouncement {
  /** The announced address: the one-time account, not its signer (0086 rule 5). */
  stealthAddress: string
  /** R, 33 bytes compressed. */
  ephemeralPublicKey: Uint8Array
  /** The first byte of the announcement's metadata. */
  viewTag: number
}

/** An announcement a scan found to be the user's. */
export interface StealthMatch {
  /** The one-time account. */
  account: string
  /** Its stealth signer. */
  signer: string
  /** h, which the `addresses` route's registration carries (0086 question 18, ruled 2026-11-19). */
  sharedSecretHash: Uint8Array
}

/**
 * Scan one announcement with a viewing key: null unless it pays this
 * meta-address. The view tag is compared first, so most foreign
 * announcements cost one curve multiplication.
 *
 * @param announcement - The announcement's account, R and view tag.
 * @param keys - The viewing private key, the spending public key of the same
 *   meta-address, and the one-time account factory.
 */
export function scanAnnouncement(
  announcement: StealthAnnouncement,
  keys: { viewingPrivateKey: Uint8Array; spendingPublicKey: Uint8Array; factory: OneTimeAccountFactory },
): StealthMatch | null {
  asScalar('viewing private key', keys.viewingPrivateKey)
  let R
  try {
    R = asPoint('ephemeral public key', announcement.ephemeralPublicKey)
  } catch {
    return null // a malformed announcement is someone else's
  }
  const shared = secp256k1.getSharedSecret(keys.viewingPrivateKey, R.toRawBytes(true), true)
  const h = keccak_256(shared)
  if (h[0] !== announcement.viewTag) return null
  let signer: string
  try {
    signer = stealthSignerFromHash(keys.spendingPublicKey, h)
  } catch {
    return null
  }
  const account = oneTimeAccountAddress(signer, keys.factory)
  if (account.toLowerCase() !== announcement.stealthAddress.toLowerCase()) return null
  return { account, signer, sharedSecretHash: h }
}

/**
 * The private key of a one-time address's signer: p = s_spend + h (mod n).
 * Only a phone holding the spending key (a phrase phone) can call it.
 *
 * @param spendingPrivateKey - s_spend, 32 bytes.
 * @param viewingPrivateKey - v, 32 bytes.
 * @param ephemeralPublicKey - R from the announcement, 33 bytes.
 * @returns The stealth private key and its address, and h.
 */
export function computeStealthPrivateKey(
  spendingPrivateKey: Uint8Array,
  viewingPrivateKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
): { privateKey: Uint8Array; signer: string; sharedSecretHash: Uint8Array } {
  const s = asScalar('spending private key', spendingPrivateKey)
  asScalar('viewing private key', viewingPrivateKey)
  asPoint('ephemeral public key', ephemeralPublicKey)
  const { h, hn } = hashSharedSecret(secp256k1.getSharedSecret(viewingPrivateKey, ephemeralPublicKey, true))
  const p = (s + hn) % N
  if (p === 0n) throw new StealthError('stealth: the stealth private key is zero')
  const privateKey = bigIntTo32(p)
  return { privateKey, signer: secp256k1Address(privateKey), sharedSecretHash: h }
}

// 0086 q18 (ruled 2026-11-19 as recommended): there is no pending route; an
// address reaches the plane from the recipient's phone (a scan, or its own
// derivation) with the handle key's signature over the address, R and h, and
// the plane checks P = S + h·G against the meta-address the registration names.
/**
 * The plane's check of an `addresses` registration (0086 rule 5 and question 18):
 * the account is the factory's for P = S + h·G, with S the spending key of
 * the meta-address the registration names, and the view tag is h[0]. The
 * handle key's signature over the registration is checked separately
 * (`RegisterAddress` in `handle.ts`), as is whether the meta-address is one
 * the identity's handles have had.
 *
 * @returns Whether the account is the meta-address's for h.
 */
export function verifyStealthRegistration(registration: {
  account: string
  metaAddress: Uint8Array | string
  sharedSecretHash: Uint8Array
  viewTag?: number | undefined
  factory: OneTimeAccountFactory
}): boolean {
  try {
    const { spendingPublicKey } = decodeMetaAddress(registration.metaAddress)
    if (registration.viewTag !== undefined && registration.viewTag !== registration.sharedSecretHash[0]) return false
    const signer = stealthSignerFromHash(spendingPublicKey, registration.sharedSecretHash)
    return oneTimeAccountAddress(signer, registration.factory).toLowerCase() === registration.account.toLowerCase()
  } catch {
    return false
  }
}
