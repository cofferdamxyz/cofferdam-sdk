import { HDNodeWallet, Mnemonic, Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  COFFERDAM_PRF_SALT,
  deriveMessagingRootKey,
  derivePrfEnvelopeKey,
  deriveRecoveryKeyMaterial,
  deriveRootKeys,
  deriveVaultRootKey,
  isValidPhrase,
  phraseSeed,
  ROOT_KEY_LABELS,
  ROOT_KEYS_SALT,
  ROOT_KEYS_VERSION,
  selfSecretFromPhrase,
} from '../src/identity/rootKeys.js'

// BIP-39's 24-word all-zero-entropy phrase. The expected hex below was
// computed independently of this module (Python hashlib PBKDF2-HMAC-SHA512
// and a hand-written RFC 5869 HKDF-SHA256), 2026-11-09.
const PHRASE = [...Array(23).fill('abandon'), 'art'].join(' ')
const SEED = '408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840'
const VAULT = '5c5c7cfa0b2e4c984bed99b938cf029e59d9b7cd0336905f9bdff9075d52decc'
const MESSAGING = '15d05b6aef1e1164b8f17356582b8cf429436643f23e9ea76e084874178499bb'
const RECOVERY_0 = '1131ecd5c9d259e5d2f3323e17097fde0e11e6299531ea9aba246be823c21dfb'
const RECOVERY_1 = '69ca913d444f82846556f2467b834cb3ea493e863063f229c27395772c69cedf'
const PRF_ENVELOPE_OF_0_TO_31 = '0abe507cd8e667bfc39ca683f14cd656a3448a9a93fa063fa2e7252a7c8f4a8b'
const PRF_SALT = '8de80f3c4cb34ada4eb9773d9bbf3ee876d7447d70bcbd254ccae9ed6b410372'
// m/44'/60'/0'/0/0 of PHRASE, the address every BIP-44 wallet shows for it.
const SELF_ADDRESS = '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

describe('rootKeys constants', () => {
  it('are the frozen values decision 0081 builds on', () => {
    expect(ROOT_KEYS_VERSION).toBe(1)
    expect(ROOT_KEYS_SALT).toBe('cofferdam-root-keys-v1')
    expect(ROOT_KEY_LABELS).toEqual({
      vault: 'cofferdam-vault-root-v1',
      messaging: 'cofferdam-messaging-root-v1',
      recovery: 'cofferdam-recovery-key-v1',
      prfEnvelope: 'cofferdam-prf-envelope-v1',
    })
    expect(Object.isFrozen(ROOT_KEY_LABELS)).toBe(true)
    expect(hex(COFFERDAM_PRF_SALT)).toBe(PRF_SALT)
  })
})

describe('phraseSeed', () => {
  it('is the BIP-39 seed with no passphrase', () => {
    expect(hex(phraseSeed(PHRASE))).toBe(SEED)
  })

  it('normalises case and the spacing around and between words', () => {
    expect(hex(phraseSeed(`  ${PHRASE.toUpperCase().replace(/ /g, ' \n ')}  `))).toBe(SEED)
  })

  it('refuses a valid 12-word phrase', () => {
    const twelve = [...Array(11).fill('abandon'), 'about'].join(' ')
    expect(Mnemonic.isValidMnemonic(twelve)).toBe(true)
    expect(() => phraseSeed(twelve)).toThrow('24 words')
  })

  it('refuses a bad checksum and an unknown word without echoing the phrase', () => {
    const badChecksum = [...Array(24).fill('abandon')].join(' ')
    const unknownWord = [...Array(23).fill('abandon'), 'cofferdam'].join(' ')
    for (const phrase of [badChecksum, unknownWord]) {
      let message = ''
      try {
        phraseSeed(phrase)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toBe('rootKeys: the phrase is not a valid BIP-39 phrase')
    }
  })

  it('refuses an empty phrase', () => {
    expect(() => phraseSeed('')).toThrow('24 words')
    expect(() => phraseSeed('   ')).toThrow('24 words')
  })
})

describe('isValidPhrase', () => {
  it('accepts exactly 24 valid words', () => {
    expect(isValidPhrase(PHRASE)).toBe(true)
    expect(isValidPhrase(` ${PHRASE} `)).toBe(true)
    expect(isValidPhrase([...Array(11).fill('abandon'), 'about'].join(' '))).toBe(false)
    expect(isValidPhrase([...Array(24).fill('abandon')].join(' '))).toBe(false)
    expect(isValidPhrase('')).toBe(false)
  })
})

describe('root key derivation', () => {
  const seed = phraseSeed(PHRASE)

  it('pins each key of the vector', () => {
    expect(hex(deriveVaultRootKey(seed))).toBe(VAULT)
    expect(hex(deriveMessagingRootKey(seed))).toBe(MESSAGING)
    expect(hex(deriveRecoveryKeyMaterial(seed))).toBe(RECOVERY_0)
    expect(hex(deriveRecoveryKeyMaterial(seed, 0))).toBe(RECOVERY_0)
    expect(hex(deriveRecoveryKeyMaterial(seed, 1))).toBe(RECOVERY_1)
    expect(hex(derivePrfEnvelopeKey(Uint8Array.from({ length: 32 }, (_, i) => i)))).toBe(PRF_ENVELOPE_OF_0_TO_31)
  })

  it('yields 32 bytes per key, pairwise distinct and deterministic', () => {
    const keys = [
      deriveVaultRootKey(seed),
      deriveMessagingRootKey(seed),
      deriveRecoveryKeyMaterial(seed, 0),
      deriveRecoveryKeyMaterial(seed, 1),
    ].map(hex)
    for (const k of keys) expect(k).toHaveLength(64)
    expect(new Set(keys).size).toBe(keys.length)
    expect(hex(deriveVaultRootKey(phraseSeed(PHRASE)))).toBe(keys[0])
  })

  it('deriveRootKeys gives the same three keys', () => {
    const keys = deriveRootKeys(PHRASE)
    expect(hex(keys.vault)).toBe(VAULT)
    expect(hex(keys.messaging)).toBe(MESSAGING)
    expect(hex(keys.recovery)).toBe(RECOVERY_0)
  })

  it('differs for another phrase', () => {
    const other = Mnemonic.fromEntropy(new Uint8Array(32).fill(7)).phrase
    expect(hex(deriveRootKeys(other).vault)).not.toBe(VAULT)
  })

  it('checks its inputs', () => {
    expect(() => deriveVaultRootKey(new Uint8Array(32))).toThrow('64 bytes')
    expect(() => deriveMessagingRootKey(new Uint8Array(65))).toThrow('64 bytes')
    expect(() => deriveRecoveryKeyMaterial(seed, -1)).toThrow('non-negative')
    expect(() => deriveRecoveryKeyMaterial(seed, 1.5)).toThrow('non-negative')
    expect(() => derivePrfEnvelopeKey(new Uint8Array(16))).toThrow('32 bytes')
  })
})

describe('selfSecretFromPhrase', () => {
  it('is exactly HDNodeWallet.fromPhrase(phrase).privateKey, the path every bound account uses', () => {
    const secret = selfSecretFromPhrase(PHRASE)
    expect(secret).toBe(HDNodeWallet.fromPhrase(PHRASE).privateKey)
    expect(secret).toBe(HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(PHRASE)).privateKey)
    expect(new Wallet(secret).address).toBe(SELF_ADDRESS)
  })

  it('matches the mint path for a fresh phrase', () => {
    const mnemonic = Mnemonic.fromEntropy(Uint8Array.from({ length: 32 }, (_, i) => (i * 37) & 0xff))
    expect(selfSecretFromPhrase(mnemonic.phrase)).toBe(HDNodeWallet.fromMnemonic(mnemonic).privateKey)
  })

  it('is not any of the root keys', () => {
    const secret = selfSecretFromPhrase(PHRASE).slice(2)
    expect([VAULT, MESSAGING, RECOVERY_0]).not.toContain(secret)
  })
})
