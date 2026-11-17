// The keys of a handle epoch, from the handle root (workspace decision 0086
// rule 1), and the seed-level handle keys as secp256k1 keys.
//
//   root_e          = rootKeys.deriveHandleRoot(seed, e)
//   handle key      = HKDF(root_e, 'cofferdam-handle-key-v1')        mod n, 0 refused
//   spending key    = HKDF(root_e, 'cofferdam-stealth-spending-v1')  mod n, 0 refused
//   viewing key     = HKDF(root_e, 'cofferdam-stealth-viewing-v1')   mod n, 0 refused
//   self seed_e     = HKDF(root_e, 'cofferdam-self-derivation-v1')   32 bytes
//   r(p, i)         = HKDF(seed_e, 'self-ephemeral' ‖ u8 p ‖ u32be i) mod n, 0 refused
//
// Every HKDF here is HKDF-SHA256 with rootKeys' salt and a 32-byte output.
// The Tier 1 key is not under the handle root: decision 0086 question 12
// (open) puts it on its own counter (rootKeys.deriveTier1KeyMaterial).
//
// The handle key signs the anchor, the registry's handle-scoped requests,
// handshake halves and rename notices, and holds no funds. A linked phone
// receives the handle key, the viewing key and the self seed of an epoch,
// never the spending key (0086 question 2; decision 0082 Decision 15).
//
// Synchronous and pure except the index walk, which awaits the caller's
// "is this address used?" check.

import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { utf8ToBytes } from '@noble/hashes/utils'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  deriveHandleReleaseKeyMaterial,
  deriveHandleRoot,
  deriveTier1KeyMaterial,
  deriveXmtpRecoveryKeyMaterial,
  ROOT_KEYS_SALT,
} from './rootKeys.js'
import {
  encodeMetaAddress,
  generateStealthAddress,
  secp256k1Address,
  secp256k1KeyFromMaterial,
  type GeneratedStealthAddress,
  type OneTimeAccountFactory,
} from './stealth.js'

// ASSUMPTION(0086 rule 1): 0086 names the keys under the handle root but not
// their HKDF labels; these are ours, frozen once a handle is claimed with them.
/** HKDF labels under the handle root of an epoch. Frozen once a handle is claimed. */
export const HANDLE_ROOT_LABELS = Object.freeze({
  handleKey: 'cofferdam-handle-key-v1',
  stealthSpending: 'cofferdam-stealth-spending-v1',
  stealthViewing: 'cofferdam-stealth-viewing-v1',
  selfDerivationSeed: 'cofferdam-self-derivation-v1',
  /** Followed by the slot as one byte and the index as four big-endian bytes (0086 rule 1). */
  selfEphemeral: 'self-ephemeral',
} as const)

/** Phone slots of the self-derivation index: 0 to 15 (0086 rule 1). */
export const SELF_DERIVATION_SLOTS = 16

/** Highest self-derivation index: the index is written as four bytes. */
export const MAX_SELF_DERIVATION_INDEX = 0xffff_ffff

/** A secp256k1 key with its public forms. */
export interface Secp256k1KeyPair {
  /** 32 bytes. */
  privateKey: Uint8Array
  /** 33 bytes, compressed. */
  publicKey: Uint8Array
  /** Checksummed Ethereum address. */
  address: string
}

/** The keys of one handle epoch. */
export interface HandleEpochKeys {
  epoch: number
  /** Signs the anchor, registry requests, halves and rename notices; its address is the anchor's `owner`. */
  handleKey: Secp256k1KeyPair
  /** The stealth spending key. Stays on phrase phones. */
  spendingKey: Secp256k1KeyPair
  /** The stealth viewing key. */
  viewingKey: Secp256k1KeyPair
  /** S ‖ V, 66 bytes: the anchor's `metaAddress`. */
  metaAddress: Uint8Array
  /** The seed of the self-derived ephemeral keys, 32 bytes. */
  selfDerivationSeed: Uint8Array
}

function labelled(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, utf8ToBytes(ROOT_KEYS_SALT), info, 32)
}

function keyPair(material: Uint8Array): Secp256k1KeyPair {
  // ASSUMPTION(0086 rule 1): 0086 states the reduction mod n with 0 refused
  // for the self-derived ephemeral key; every secp256k1 key here uses it.
  const privateKey = secp256k1KeyFromMaterial(material)
  material.fill(0)
  return { privateKey, publicKey: secp256k1.getPublicKey(privateKey, true), address: secp256k1Address(privateKey) }
}

/**
 * The keys of handle epoch `epoch` (decision 0086 rule 1).
 *
 * @param seed - The phrase's 64-byte seed (`phraseSeed`).
 * @param epoch - The epoch, 0 first.
 */
export function deriveHandleEpochKeys(seed: Uint8Array, epoch: number): HandleEpochKeys {
  const root = deriveHandleRoot(seed, epoch)
  try {
    const handleKey = keyPair(labelled(root, utf8ToBytes(HANDLE_ROOT_LABELS.handleKey)))
    const spendingKey = keyPair(labelled(root, utf8ToBytes(HANDLE_ROOT_LABELS.stealthSpending)))
    const viewingKey = keyPair(labelled(root, utf8ToBytes(HANDLE_ROOT_LABELS.stealthViewing)))
    return {
      epoch,
      handleKey,
      spendingKey,
      viewingKey,
      metaAddress: encodeMetaAddress(spendingKey.publicKey, viewingKey.publicKey),
      selfDerivationSeed: labelled(root, utf8ToBytes(HANDLE_ROOT_LABELS.selfDerivationSeed)),
    }
  } finally {
    root.fill(0)
  }
}

/**
 * The Tier 1 XMTP identity key number `k` (decision 0086 question 12, open):
 * registered with XMTP as a plain key, it signs identity actions only.
 *
 * @param seed - The phrase's 64-byte seed.
 * @param k - The counter, 0 first; it moves only after a theft, an alarm or a phrase rotation.
 */
export function deriveTier1IdentityKey(seed: Uint8Array, k = 0): Secp256k1KeyPair {
  return keyPair(deriveTier1KeyMaterial(seed, k))
}

/**
 * The XMTP recovery identity (decision 0086 rule 1): revokes installations
 * and replaces identity keys. Only the phrase derives it, and no linked phone
 * receives it.
 *
 * @param seed - The phrase's 64-byte seed.
 */
export function deriveXmtpRecoveryIdentity(seed: Uint8Array): Secp256k1KeyPair {
  return keyPair(deriveXmtpRecoveryKeyMaterial(seed))
}

/**
 * The release key of a releasing label (decision 0086 question 13, open): a
 * phrase phone moves the old record to it when the anchor watch sees a
 * cancelled release or a queued change it did not make.
 *
 * @param seed - The phrase's 64-byte seed (the new phrase's after a rotation).
 * @param handleId - The releasing label's 32-byte `handleId`.
 */
export function deriveHandleReleaseKey(seed: Uint8Array, handleId: Uint8Array): Secp256k1KeyPair {
  return keyPair(deriveHandleReleaseKeyMaterial(seed, handleId))
}

function assertSlotIndex(slot: number, index: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SELF_DERIVATION_SLOTS) {
    throw new Error(`handleRoot: the slot must be an integer from 0 to ${SELF_DERIVATION_SLOTS - 1}`)
  }
  if (!Number.isInteger(index) || index < 0 || index > MAX_SELF_DERIVATION_INDEX) {
    throw new Error('handleRoot: the index must be an integer from 0 to 2^32 - 1')
  }
}

/**
 * The ephemeral private key r of the self-derived address (p, i) (decision
 * 0086 rule 1): addresses the user's own phones derive (an escrow's receive
 * address, a funding address), found again by index without the plane.
 *
 * @param selfDerivationSeed - The epoch's self-derivation seed.
 * @param slot - The phone's slot p, 0 to 15, from 0082's synced device list.
 * @param index - i, 0 to 2^32 - 1.
 * @returns 32 bytes.
 */
export function deriveSelfEphemeralKey(selfDerivationSeed: Uint8Array, slot: number, index: number): Uint8Array {
  if (!(selfDerivationSeed instanceof Uint8Array) || selfDerivationSeed.length !== 32) {
    throw new Error('handleRoot: the self-derivation seed must be 32 bytes')
  }
  assertSlotIndex(slot, index)
  // ASSUMPTION(0086 rule 1): 'self-ephemeral' ‖ p ‖ i is written as the
  // label's UTF-8 bytes, p as one byte and i as four big-endian bytes, so no
  // two (p, i) pairs share an info string.
  const label = utf8ToBytes(HANDLE_ROOT_LABELS.selfEphemeral)
  const info = new Uint8Array(label.length + 5)
  info.set(label, 0)
  info[label.length] = slot
  new DataView(info.buffer).setUint32(label.length + 1, index, false)
  return secp256k1KeyFromMaterial(labelled(selfDerivationSeed, info))
}

/** A self-derived one-time address. */
export interface SelfDerivedAddress extends GeneratedStealthAddress {
  slot: number
  index: number
}

/**
 * The self-derived one-time address (p, i) of a meta-address: the stealth
 * derivation with r(p, i) as the ephemeral key. A linked phone, which holds
 * no spending key, derives it from the public meta-address.
 *
 * @param input - The epoch's self seed and meta-address, the factory, the slot and the index.
 */
export function deriveSelfAddress(input: {
  selfDerivationSeed: Uint8Array
  metaAddress: Uint8Array | string
  factory: OneTimeAccountFactory
  slot: number
  index: number
}): SelfDerivedAddress {
  const r = deriveSelfEphemeralKey(input.selfDerivationSeed, input.slot, input.index)
  try {
    return { ...generateStealthAddress(input.metaAddress, input.factory, r), slot: input.slot, index: input.index }
  } finally {
    r.fill(0)
  }
}

/**
 * Recovery's walk of the self-derived addresses (decision 0086 rule 1): every
 * slot from index 0 until `gapLimit` unused indexes in a row.
 *
 * @param input.isUsed - Whether an account has ever been used (a balance, a
 *   transfer, an escrow naming it); the caller reads the chain or the feed.
 * @param input.gapLimit - Unused indexes in a row that end a slot; 20 by default.
 * @param input.slots - The slots to walk; all 16 by default.
 * @returns Every used address, slot by slot, index by index.
 */
export async function walkSelfDerivedAddresses(input: {
  selfDerivationSeed: Uint8Array
  metaAddress: Uint8Array | string
  factory: OneTimeAccountFactory
  isUsed: (account: string) => boolean | Promise<boolean>
  gapLimit?: number | undefined
  slots?: readonly number[] | undefined
}): Promise<SelfDerivedAddress[]> {
  const gapLimit = input.gapLimit ?? 20
  if (!Number.isInteger(gapLimit) || gapLimit < 1) throw new Error('handleRoot: the gap limit must be a positive integer')
  const slots = input.slots ?? Array.from({ length: SELF_DERIVATION_SLOTS }, (_, p) => p)
  const found: SelfDerivedAddress[] = []
  for (const slot of slots) {
    let misses = 0
    for (let index = 0; misses < gapLimit && index <= MAX_SELF_DERIVATION_INDEX; index++) {
      const address = deriveSelfAddress({ ...input, slot, index })
      if (await input.isUsed(address.account)) {
        found.push(address)
        misses = 0
      } else {
        misses++
      }
    }
  }
  return found
}

/**
 * Recovery's epoch search (decision 0086 rule 1): the first epoch whose handle
 * key's address is the anchor's `owner`, or null within `maxEpochs`.
 *
 * @param seed - The phrase's 64-byte seed (each legacy phrase is searched with its own).
 * @param owner - The anchor record's `owner`.
 * @param maxEpochs - Epochs to try, from 0; 64 by default.
 */
export function findHandleEpoch(seed: Uint8Array, owner: string, maxEpochs = 64): number | null {
  const want = owner.toLowerCase()
  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    const keys = deriveHandleEpochKeys(seed, epoch)
    const match = keys.handleKey.address.toLowerCase() === want
    keys.handleKey.privateKey.fill(0)
    keys.spendingKey.privateKey.fill(0)
    keys.viewingKey.privateKey.fill(0)
    keys.selfDerivationSeed.fill(0)
    if (match) return epoch
  }
  return null
}
