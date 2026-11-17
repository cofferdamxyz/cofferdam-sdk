import { computeAddress, hexlify, Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  deriveHandleEpochKeys,
  deriveHandleReleaseKey,
  deriveHandleReleaseKeyMaterial,
  deriveHandleRoot,
  deriveMessagingRootKey,
  deriveSelfAddress,
  deriveSelfEphemeralKey,
  deriveTier1IdentityKey,
  deriveTier1KeyMaterial,
  deriveVaultRootKey,
  deriveXmtpRecoveryIdentity,
  deriveXmtpRecoveryKeyMaterial,
  findHandleEpoch,
  FIXTURE_ONE_TIME_FACTORY,
  HANDLE_ROOT_LABELS,
  HANDLE_SEED_LABELS,
  phraseSeed,
  ROOT_KEY_LABELS,
  scanAnnouncement,
  walkSelfDerivedAddresses,
} from '../src/index.js'

// BIP-39's all-zero 24-word phrase, as rootKeys.test.ts. The expected hex was
// computed outside this code (Python hmac/hashlib HKDF-SHA256, the reduction
// mod n in Python integers), 2026-11-17.
const PHRASE = [...Array(23).fill('abandon'), 'art'].join(' ')
const ROOT0 = '94da4b6cf46748e39ea91682dc7150868f752ecc182256df0b4bd3e2dc495c07'
const ROOT1 = '146bcda5c19c03bd17cc8c1503f43f0cbe048c2973bc8a1e8447ae341187950a'
const HANDLE_KEY0 = 'aca0d0cd9af167acd7994c29b25ed855d0e13e0f78394678d32fd5fa2ad4cd12'
const SPEND0 = 'c5a54d8a334eb9bc139194e08aa5f0022fb78042579295bd3ee6428588c357e4'
const VIEW0 = 'eec2c34147107ea7f38e1186c766e4736d943506c7101078dc0a2a58cf812bdc'
const SELF_SEED0 = '4213b129055b06316821e43b65917e392a8cb2f1f83daf1043ab6d42c90666e7'
const SELF_EPH0_3_7 = '7bffb0c6ad4f7194617b8eaa5e4a47d5a4cb2976bfb7e2c9a9f2d6c77e37c2bb'
const HANDLE_KEY1 = '68ce96b4186eef6ea39641de489b951e53f8e7700f3d055bd302aa9f82e7d793'
const TIER1_0 = 'a9688a41a7ad878c135122f8ba6679288bfb740505ae58dd53b945cf7ea91992'
const TIER1_1 = '27ed3e5ffbd30bbd5336b183680e7d88197b09a09a69c1aac68f3b7236a197b7'
const XMTP_RECOVERY = '53c365b54c3db5075d4ba72df0adb8711be9c727e89570d174e0a5d7c78d2a0e'
const RELEASE_OF_AB = 'ade350d52ac2055db3ebb34f3e2cf50a100cc9abf3f63161e0da89f86a214bb6'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const seed = () => phraseSeed(PHRASE)

describe('rootKeys: the handle labels of decision 0086', () => {
  it('leave decision 0081 labels and outputs as they were', () => {
    expect(Object.keys(ROOT_KEY_LABELS)).toEqual(['vault', 'messaging', 'recovery', 'prfEnvelope'])
    expect(hex(deriveVaultRootKey(seed()))).toBe('5c5c7cfa0b2e4c984bed99b938cf029e59d9b7cd0336905f9bdff9075d52decc')
    expect(hex(deriveMessagingRootKey(seed()))).toBe('15d05b6aef1e1164b8f17356582b8cf429436643f23e9ea76e084874178499bb')
  })

  it('are frozen and named as 0086 and its open questions say', () => {
    expect(HANDLE_SEED_LABELS).toEqual({
      handleRoot: 'cofferdam-handle-root-v1',
      tier1: 'cofferdam-tier1-v1',
      xmtpRecovery: 'cofferdam-xmtp-recovery-v1',
      handleRelease: 'cofferdam-handle-release-v1',
    })
    expect(Object.isFrozen(HANDLE_SEED_LABELS)).toBe(true)
    expect(Object.isFrozen(HANDLE_ROOT_LABELS)).toBe(true)
  })

  it('derive the handle root per epoch', () => {
    expect(hex(deriveHandleRoot(seed(), 0))).toBe(ROOT0)
    expect(hex(deriveHandleRoot(seed(), 1))).toBe(ROOT1)
  })

  it('derive the Tier 1, XMTP recovery and release material', () => {
    expect(hex(deriveTier1KeyMaterial(seed(), 0))).toBe(TIER1_0)
    expect(hex(deriveTier1KeyMaterial(seed(), 1))).toBe(TIER1_1)
    expect(hex(deriveXmtpRecoveryKeyMaterial(seed()))).toBe(XMTP_RECOVERY)
    expect(hex(deriveHandleReleaseKeyMaterial(seed(), new Uint8Array(32).fill(0xab)))).toBe(RELEASE_OF_AB)
  })

  it('refuse a bad seed, epoch, counter or handleId', () => {
    expect(() => deriveHandleRoot(new Uint8Array(32), 0)).toThrow('64 bytes')
    expect(() => deriveHandleRoot(seed(), -1)).toThrow('non-negative')
    expect(() => deriveHandleRoot(seed(), 1.5)).toThrow('non-negative')
    expect(() => deriveTier1KeyMaterial(seed(), -1)).toThrow('non-negative')
    expect(() => deriveHandleReleaseKeyMaterial(seed(), new Uint8Array(31))).toThrow('32 bytes')
  })
})

describe('handleRoot: the keys of an epoch', () => {
  it('match the independent vectors', () => {
    const k = deriveHandleEpochKeys(seed(), 0)
    expect(hex(k.handleKey.privateKey)).toBe(HANDLE_KEY0)
    expect(hex(k.spendingKey.privateKey)).toBe(SPEND0)
    expect(hex(k.viewingKey.privateKey)).toBe(VIEW0)
    expect(hex(k.selfDerivationSeed)).toBe(SELF_SEED0)
    expect(hex(deriveHandleEpochKeys(seed(), 1).handleKey.privateKey)).toBe(HANDLE_KEY1)
    expect(hex(deriveSelfEphemeralKey(k.selfDerivationSeed, 3, 7))).toBe(SELF_EPH0_3_7)
  })

  it('give addresses and public keys ethers agrees with', () => {
    const k = deriveHandleEpochKeys(seed(), 0)
    for (const key of [k.handleKey, k.spendingKey, k.viewingKey]) {
      const w = new Wallet(hexlify(key.privateKey))
      expect(key.address).toBe(w.address)
      expect(hexlify(key.publicKey)).toBe(w.signingKey.compressedPublicKey)
    }
    expect(hexlify(k.metaAddress)).toBe(hexlify(k.spendingKey.publicKey) + hex(k.viewingKey.publicKey))
    expect(k.metaAddress.length).toBe(66)
  })

  it('are the same on two runs and different per epoch', () => {
    const a = deriveHandleEpochKeys(seed(), 2)
    const b = deriveHandleEpochKeys(seed(), 2)
    expect(hex(a.metaAddress)).toBe(hex(b.metaAddress))
    expect(a.handleKey.address).toBe(b.handleKey.address)
    const c = deriveHandleEpochKeys(seed(), 3)
    expect(c.handleKey.address).not.toBe(a.handleKey.address)
    expect(hex(c.metaAddress)).not.toBe(hex(a.metaAddress))
  })

  it('keep the five keys of a phrase apart', () => {
    const k = deriveHandleEpochKeys(seed(), 0)
    const all = [
      k.handleKey.address,
      k.spendingKey.address,
      k.viewingKey.address,
      deriveTier1IdentityKey(seed(), 0).address,
      deriveXmtpRecoveryIdentity(seed()).address,
      deriveHandleReleaseKey(seed(), new Uint8Array(32)).address,
    ]
    expect(new Set(all).size).toBe(all.length)
    expect(hex(deriveTier1IdentityKey(seed(), 0).privateKey)).toBe(TIER1_0) // below n, unchanged by the reduction
    expect(deriveXmtpRecoveryIdentity(seed()).address).toBe(computeAddress('0x' + XMTP_RECOVERY))
  })
})

describe('findHandleEpoch', () => {
  it('finds the epoch whose handle key owns the anchor', () => {
    const owner = deriveHandleEpochKeys(seed(), 3).handleKey.address
    expect(findHandleEpoch(seed(), owner)).toBe(3)
    expect(findHandleEpoch(seed(), owner.toLowerCase())).toBe(3)
    expect(findHandleEpoch(seed(), owner, 3)).toBeNull()
    expect(findHandleEpoch(seed(), '0x' + '11'.repeat(20), 5)).toBeNull()
  })
})

describe('self-derived addresses', () => {
  const k = deriveHandleEpochKeys(phraseSeed(PHRASE), 0)
  const base = { selfDerivationSeed: k.selfDerivationSeed, metaAddress: k.metaAddress, factory: FIXTURE_ONE_TIME_FACTORY }

  it('refuse a slot outside 0 to 15 and an index outside 32 bits', () => {
    expect(() => deriveSelfEphemeralKey(k.selfDerivationSeed, 16, 0)).toThrow('slot')
    expect(() => deriveSelfEphemeralKey(k.selfDerivationSeed, -1, 0)).toThrow('slot')
    expect(() => deriveSelfEphemeralKey(k.selfDerivationSeed, 0, 2 ** 32)).toThrow('index')
    expect(() => deriveSelfEphemeralKey(new Uint8Array(31), 0, 0)).toThrow('32 bytes')
  })

  it('differ per slot and per index', () => {
    const keys = new Set<string>()
    for (let p = 0; p < 3; p++) for (let i = 0; i < 3; i++) keys.add(hex(deriveSelfEphemeralKey(k.selfDerivationSeed, p, i)))
    expect(keys.size).toBe(9)
  })

  it('are found by the owner’s scan like any payment', () => {
    const a = deriveSelfAddress({ ...base, slot: 2, index: 5 })
    const match = scanAnnouncement(
      { stealthAddress: a.account, ephemeralPublicKey: a.ephemeralPublicKey, viewTag: a.viewTag },
      { viewingPrivateKey: k.viewingKey.privateKey, spendingPublicKey: k.spendingKey.publicKey, factory: FIXTURE_ONE_TIME_FACTORY },
    )
    expect(match?.account).toBe(a.account)
  })

  it('are walked with a gap limit per slot', async () => {
    const used = new Set([
      deriveSelfAddress({ ...base, slot: 0, index: 0 }).account,
      deriveSelfAddress({ ...base, slot: 0, index: 4 }).account,
      deriveSelfAddress({ ...base, slot: 1, index: 9 }).account, // past the gap of 5: not found
      deriveSelfAddress({ ...base, slot: 15, index: 1 }).account,
    ])
    let calls = 0
    const found = await walkSelfDerivedAddresses({
      ...base,
      gapLimit: 5,
      isUsed: async (a) => {
        calls++
        return used.has(a)
      },
    })
    expect(found.map((f) => [f.slot, f.index])).toEqual([
      [0, 0],
      [0, 4],
      [15, 1],
    ])
    // slot 0: indexes 0..9; slot 15: 0..6; the other 14 slots: 0..4.
    expect(calls).toBe(10 + 7 + 14 * 5)
    await expect(walkSelfDerivedAddresses({ ...base, gapLimit: 0, isUsed: () => false })).rejects.toThrow('gap limit')
  })
})
