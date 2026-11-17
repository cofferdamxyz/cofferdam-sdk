import { computeAddress, getCreate2Address, hexlify, keccak256, SigningKey, Wallet, zeroPadValue } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  computeStealthPrivateKey,
  decodeMetaAddress,
  encodeMetaAddress,
  FIXTURE_ONE_TIME_FACTORY,
  generateStealthAddress,
  META_ADDRESS_BYTES,
  oneTimeAccountAddress,
  scanAnnouncement,
  StealthError,
  stealthSignerFromHash,
  verifyStealthRegistration,
} from '../src/index.js'

// No published ERC-5564 test vectors exist (searched 2026-11-17). The
// reference implementation (ScopeLift's stealth-address-sdk) hashes noble's
// compressed shared secret with keccak256 and takes the first byte as the
// view tag; `reference` below repeats that with ethers' own curve code, so
// the module is checked against a second implementation.
function reference(metaHex: string, r: string) {
  const S = '0x' + metaHex.slice(2, 68)
  const V = '0x' + metaHex.slice(68)
  const shared = SigningKey.computePublicKey(new SigningKey(r).computeSharedSecret(V), true)
  const h = keccak256(shared)
  const P = SigningKey.addPoints(S, SigningKey.computePublicKey(h, true))
  return { h, viewTag: Number.parseInt(h.slice(2, 4), 16), signer: computeAddress(P), R: SigningKey.computePublicKey(r, true) }
}

const spend = Wallet.createRandom()
const view = Wallet.createRandom()
const sBytes = Buffer.from(spend.privateKey.slice(2), 'hex')
const vBytes = Buffer.from(view.privateKey.slice(2), 'hex')
const meta = encodeMetaAddress(
  Buffer.from(spend.signingKey.compressedPublicKey.slice(2), 'hex'),
  Buffer.from(view.signingKey.compressedPublicKey.slice(2), 'hex'),
)
const F = FIXTURE_ONE_TIME_FACTORY

describe('meta-address codec', () => {
  it('is the spending key then the viewing key, compressed, 66 bytes', () => {
    expect(meta.length).toBe(META_ADDRESS_BYTES)
    expect(hexlify(meta)).toBe(spend.signingKey.compressedPublicKey + view.signingKey.compressedPublicKey.slice(2))
    const d = decodeMetaAddress(hexlify(meta))
    expect(hexlify(d.spendingPublicKey)).toBe(spend.signingKey.compressedPublicKey)
    expect(hexlify(d.viewingPublicKey)).toBe(view.signingKey.compressedPublicKey)
  })

  it('refuses a wrong length, a point off the curve and bad hex', () => {
    expect(() => decodeMetaAddress(meta.slice(0, 65))).toThrow(StealthError)
    const off = Uint8Array.from(meta)
    off[1] = off[1]! ^ 0xff
    off.set(new Uint8Array(32).fill(0xff), 1) // x >= p
    expect(() => decodeMetaAddress(off)).toThrow('not a point')
    expect(() => decodeMetaAddress('0xzz')).toThrow('hex')
    expect(() => encodeMetaAddress(new Uint8Array(33), meta.slice(33))).toThrow(StealthError)
  })
})

describe('ERC-5564 scheme 1', () => {
  it('derives what an independent implementation derives', () => {
    for (let n = 0; n < 5; n++) {
      const r = Wallet.createRandom().privateKey
      const g = generateStealthAddress(meta, F, Buffer.from(r.slice(2), 'hex'))
      const ref = reference(hexlify(meta), r)
      expect(hexlify(g.sharedSecretHash)).toBe(ref.h)
      expect(g.viewTag).toBe(ref.viewTag)
      expect(g.signer).toBe(ref.signer)
      expect(hexlify(g.ephemeralPublicKey)).toBe(ref.R)
      expect(g.account).toBe(getCreate2Address(F.address, zeroPadValue(g.signer, 32), F.initCodeHash))
    }
  })

  it('lets the recipient compute the signer’s private key', () => {
    const g = generateStealthAddress(meta, F)
    const p = computeStealthPrivateKey(sBytes, vBytes, g.ephemeralPublicKey)
    expect(p.signer).toBe(g.signer)
    expect(new Wallet(hexlify(p.privateKey)).address).toBe(g.signer)
    expect(hexlify(p.sharedSecretHash)).toBe(hexlify(g.sharedSecretHash))
  })

  it('gives a fresh address each time without an ephemeral key', () => {
    const a = generateStealthAddress(meta, F)
    const b = generateStealthAddress(meta, F)
    expect(a.account).not.toBe(b.account)
    expect(a.signer).not.toBe(b.signer)
  })

  it('finds its own announcements and ignores others', () => {
    const g = generateStealthAddress(meta, F)
    const keys = { viewingPrivateKey: vBytes, spendingPublicKey: meta.slice(0, 33), factory: F }
    const hit = scanAnnouncement({ stealthAddress: g.account.toLowerCase(), ephemeralPublicKey: g.ephemeralPublicKey, viewTag: g.viewTag }, keys)
    expect(hit?.account).toBe(g.account)
    expect(hit?.signer).toBe(g.signer)
    // the signer is not what announcements name
    expect(scanAnnouncement({ stealthAddress: g.signer, ephemeralPublicKey: g.ephemeralPublicKey, viewTag: g.viewTag }, keys)).toBeNull()
    // a wrong view tag is dropped before any further work
    expect(scanAnnouncement({ stealthAddress: g.account, ephemeralPublicKey: g.ephemeralPublicKey, viewTag: (g.viewTag + 1) % 256 }, keys)).toBeNull()
    // someone else's payment
    const other = Wallet.createRandom()
    const otherMeta = encodeMetaAddress(Buffer.from(other.signingKey.compressedPublicKey.slice(2), 'hex'), meta.slice(33))
    const o = generateStealthAddress(otherMeta, F)
    expect(scanAnnouncement({ stealthAddress: o.account, ephemeralPublicKey: o.ephemeralPublicKey, viewTag: o.viewTag }, keys)).toBeNull()
    // a malformed R
    expect(scanAnnouncement({ stealthAddress: g.account, ephemeralPublicKey: new Uint8Array(33), viewTag: g.viewTag }, keys)).toBeNull()
  })

  it('checks a registration as P = S + h·G without r or the viewing key', () => {
    const g = generateStealthAddress(meta, F)
    expect(stealthSignerFromHash(meta.slice(0, 33), g.sharedSecretHash)).toBe(g.signer)
    const ok = { account: g.account, metaAddress: meta, sharedSecretHash: g.sharedSecretHash, viewTag: g.viewTag, factory: F }
    expect(verifyStealthRegistration(ok)).toBe(true)
    expect(verifyStealthRegistration({ ...ok, viewTag: undefined })).toBe(true)
    expect(verifyStealthRegistration({ ...ok, account: g.signer })).toBe(false)
    expect(verifyStealthRegistration({ ...ok, viewTag: (g.viewTag + 1) % 256 })).toBe(false)
    expect(verifyStealthRegistration({ ...ok, sharedSecretHash: new Uint8Array(32).fill(1) })).toBe(false)
    expect(verifyStealthRegistration({ ...ok, metaAddress: new Uint8Array(66) })).toBe(false)
    expect(verifyStealthRegistration({ ...ok, factory: { ...F, initCodeHash: '0x' + '00'.repeat(32) } })).toBe(false)
  })

  it('refuses keys and hashes outside the curve order', () => {
    const n = Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex')
    expect(() => generateStealthAddress(meta, F, n)).toThrow('not a valid secp256k1 key')
    expect(() => generateStealthAddress(meta, F, new Uint8Array(32))).toThrow('not a valid secp256k1 key')
    expect(() => stealthSignerFromHash(meta.slice(0, 33), n)).toThrow('curve order')
    expect(() => computeStealthPrivateKey(new Uint8Array(32), vBytes, meta.slice(33))).toThrow(StealthError)
  })
})

describe('oneTimeAccountAddress', () => {
  it('is CREATE2 with the signer as the salt', () => {
    const signer = Wallet.createRandom().address
    expect(oneTimeAccountAddress(signer, F)).toBe(getCreate2Address(F.address, zeroPadValue(signer, 32), F.initCodeHash))
  })

  it('has a placeholder factory that is hashes of fixed strings', () => {
    expect(F.address.toLowerCase()).toBe('0x' + keccak256(Buffer.from('cofferdam-fixture-one-time-factory-v0')).slice(26))
    expect(F.initCodeHash).toBe(keccak256(Buffer.from('cofferdam-fixture-one-time-account-v0')))
    expect(Object.isFrozen(F)).toBe(true)
  })
})
