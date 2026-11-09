// The account's long-lived secrets from its one root, the 24-word phrase
// (workspace decision 0081, item 1; decisions 0025 rule 4, 0039 rule 7, 0080).
//
//   seed       = BIP-39 seed of the phrase (PBKDF2-HMAC-SHA512, 2048 rounds, 64 bytes)
//   vault      = HKDF-SHA256(ikm = seed, salt = ROOT_KEYS_SALT, info = 'cofferdam-vault-root-v1', 32)
//   messaging  = HKDF-SHA256(ikm = seed, salt = ROOT_KEYS_SALT, info = 'cofferdam-messaging-root-v1', 32)
//   recovery i = HKDF-SHA256(ikm = seed, salt = ROOT_KEYS_SALT, info = 'cofferdam-recovery-key-v1:<i>', 32)
//   PRF key    = HKDF-SHA256(ikm = PRF output, salt = ROOT_KEYS_SALT, info = 'cofferdam-prf-envelope-v1', 32)
//
// Each key has its own HKDF label, so learning one says nothing of another,
// and none sits on a BIP-32 wallet path (`m/44'/60'`). The passport secret
// Self binds today is the exception the decision keeps: it stays on ethers'
// default path, `HDNodeWallet.fromPhrase(phrase).privateKey`, because a new
// path would be a new identity for every bound account; `selfSecretFromPhrase`
// is that derivation, unchanged, so no feature derives its own.
//
// Keys are keyed to the identity's root, never to an account address: the
// address is a generation detail (decision 0025). Every constant below is
// frozen once a Vault exists, since changing one orphans every mirror and
// every PRF envelope.
//
// Synchronous and pure: `Uint8Array` in and out, nothing persisted, nothing
// logged. Hashing is `@noble/hashes`, never WebCrypto (Hermes has none; see
// pseudonym.ts); the BIP-39 seed is ethers' `Mnemonic.computeSeed()`, which
// runs on Hermes through the same noble PBKDF2.

import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { utf8ToBytes } from '@noble/hashes/utils'
import { getBytes, HDNodeWallet, Mnemonic } from 'ethers'

/** Version of the derivation scheme below. Frozen once a Vault exists. */
export const ROOT_KEYS_VERSION = 1

/** HKDF salt shared by every root key. Frozen once a Vault exists. */
export const ROOT_KEYS_SALT = 'cofferdam-root-keys-v1'

/** HKDF labels, one per purpose. Frozen once a Vault exists. */
export const ROOT_KEY_LABELS = Object.freeze({
  vault: 'cofferdam-vault-root-v1',
  messaging: 'cofferdam-messaging-root-v1',
  recovery: 'cofferdam-recovery-key-v1',
  prfEnvelope: 'cofferdam-prf-envelope-v1',
} as const)

/**
 * The WebAuthn PRF salt (`extensions.prf.eval.first`) every Cofferdam passkey
 * is asserted with for the PRF envelope: SHA-256 of `cofferdam-prf-salt-v1`,
 * 32 bytes. Frozen once an envelope exists.
 */
export const COFFERDAM_PRF_SALT: Uint8Array = sha256(utf8ToBytes('cofferdam-prf-salt-v1'))

/** Words in the account's phrase: 24 (256 bits of entropy). */
export const ROOT_PHRASE_WORDS = 24

const SEED_BYTES = 64
const KEY_BYTES = 32

/** The three keys derived from the phrase itself (the PRF key comes from a passkey). */
export interface CofferdamRootKeys {
  /** Key-encryption key of the Vault: wraps each document's, the database's and the contact backup's data key. */
  vault: Uint8Array
  /** Messaging root key of decision 0039 (rule 7). */
  messaging: Uint8Array
  /** Recovery key material, index 0 (decision 0080; the curve and the commitment are that decision's). */
  recovery: Uint8Array
}

function wordCount(phrase: string): number {
  const trimmed = phrase.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

function deriveLabelled(ikm: Uint8Array, label: string): Uint8Array {
  return hkdf(sha256, ikm, utf8ToBytes(ROOT_KEYS_SALT), utf8ToBytes(label), KEY_BYTES)
}

function assertSeed(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) {
    throw new Error(`rootKeys: the seed must be ${SEED_BYTES} bytes`)
  }
}

/**
 * Whether `phrase` is a valid 24-word BIP-39 English phrase (word list and
 * checksum). A valid 12-word phrase is not the account's root and answers
 * false. Case and spacing between words are normalised as ethers does.
 *
 * @param phrase - The phrase as typed or stored.
 */
export function isValidPhrase(phrase: string): boolean {
  if (typeof phrase !== 'string' || wordCount(phrase) !== ROOT_PHRASE_WORDS) return false
  try {
    return Mnemonic.isValidMnemonic(phrase.trim())
  } catch {
    return false
  }
}

/**
 * The BIP-39 seed of a 24-word phrase (no passphrase): 64 bytes. The caller
 * zeroes it when done.
 *
 * @param phrase - A 24-word BIP-39 English phrase.
 * @throws when the phrase is not 24 words, holds a word outside the list or
 *   fails its checksum (the message never contains the phrase).
 */
export function phraseSeed(phrase: string): Uint8Array {
  if (typeof phrase !== 'string' || wordCount(phrase) !== ROOT_PHRASE_WORDS) {
    throw new Error(`rootKeys: the phrase must be ${ROOT_PHRASE_WORDS} words`)
  }
  let mnemonic: Mnemonic
  try {
    mnemonic = Mnemonic.fromPhrase(phrase.trim())
  } catch {
    throw new Error('rootKeys: the phrase is not a valid BIP-39 phrase')
  }
  return getBytes(mnemonic.computeSeed())
}

/**
 * The Vault root key: the key-encryption key that wraps every Vault data key.
 *
 * @param seed - The phrase's 64-byte seed (`phraseSeed`).
 * @returns 32 bytes.
 */
export function deriveVaultRootKey(seed: Uint8Array): Uint8Array {
  assertSeed(seed)
  return deriveLabelled(seed, ROOT_KEY_LABELS.vault)
}

/**
 * The messaging root key of decision 0039 (rule 7).
 *
 * @param seed - The phrase's 64-byte seed (`phraseSeed`).
 * @returns 32 bytes.
 */
export function deriveMessagingRootKey(seed: Uint8Array): Uint8Array {
  assertSeed(seed)
  return deriveLabelled(seed, ROOT_KEY_LABELS.messaging)
}

/**
 * Recovery key material for decision 0080's recovery key, one value per index
 * so the key can rotate (label `cofferdam-recovery-key-v1:<index>`). The
 * module yields material only; the curve, the commitment and the rotation
 * rule are decision 0080's.
 *
 * @param seed - The phrase's 64-byte seed (`phraseSeed`).
 * @param index - Rotation index, a non-negative safe integer; 0 first.
 * @returns 32 bytes.
 */
export function deriveRecoveryKeyMaterial(seed: Uint8Array, index = 0): Uint8Array {
  assertSeed(seed)
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('rootKeys: the recovery index must be a non-negative integer')
  }
  return deriveLabelled(seed, `${ROOT_KEY_LABELS.recovery}:${index}`)
}

/**
 * The key that wraps the root keys in a passkey's PRF envelope, from the
 * PRF output (`results.first`) of an assertion evaluated with
 * `COFFERDAM_PRF_SALT`.
 *
 * @param prfFirst - The 32-byte PRF output.
 * @returns 32 bytes.
 */
export function derivePrfEnvelopeKey(prfFirst: Uint8Array): Uint8Array {
  if (!(prfFirst instanceof Uint8Array) || prfFirst.length !== KEY_BYTES) {
    throw new Error(`rootKeys: the PRF output must be ${KEY_BYTES} bytes`)
  }
  return deriveLabelled(prfFirst, ROOT_KEY_LABELS.prfEnvelope)
}

/**
 * The secret Self binds the passport to, exactly as the app has derived it
 * since the first bind: `HDNodeWallet.fromPhrase(phrase).privateKey`, ethers'
 * default path `m/44'/60'/0'/0/0`. Unchanged on purpose: another path would
 * be a new identity for every bound account. Unlike the root keys it accepts
 * any phrase ethers accepts, as the app always has.
 *
 * @param phrase - The phrase as stored or typed.
 * @returns The `0x`-prefixed 32-byte private key as hex.
 */
export function selfSecretFromPhrase(phrase: string): string {
  return HDNodeWallet.fromPhrase(phrase).privateKey
}

/**
 * The vault, messaging and recovery (index 0) keys of a 24-word phrase in one
 * call; the intermediate seed is zeroed before returning.
 *
 * @param phrase - A 24-word BIP-39 English phrase.
 * @throws as `phraseSeed`.
 */
export function deriveRootKeys(phrase: string): CofferdamRootKeys {
  const seed = phraseSeed(phrase)
  try {
    return {
      vault: deriveVaultRootKey(seed),
      messaging: deriveMessagingRootKey(seed),
      recovery: deriveRecoveryKeyMaterial(seed, 0),
    }
  } finally {
    seed.fill(0)
  }
}
