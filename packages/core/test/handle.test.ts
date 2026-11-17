import { id, keccak256, toUtf8Bytes, TypedDataEncoder, verifyTypedData, Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  HANDLE_ANCHOR_TYPES,
  HANDLE_REGISTRY_TYPES,
  handleAnchorDomain,
  handleId,
  handleRegistryDomain,
  handleTypedDataDigest,
  handleTypeString,
  isHandle,
  recoverHandleTypedDataSigner,
  signHandleTypedData,
  toHandle,
} from '../src/index.js'

// The grammar cases are the app's (`cofferdam-app` `src/lib/handleGrammar.test.ts`
// on `zkpassport-test`), so the two agree until the app imports this one.
describe('toHandle (ENS label rules, ENSIP-15)', () => {
  it('normalises case, full-width letters and a leading @', () => {
    expect(toHandle('Hoff')).toBe('hoff')
    expect(toHandle('@ana-luz')).toBe('ana-luz')
    expect(toHandle('  ＡＮＡ  ')).toBe('ana')
    expect(toHandle('ana123')).toBe('ana123')
  })

  it('refuses what an ENS label of ours cannot be', () => {
    for (const bad of [
      'maria_silva',
      '_ana',
      '-ana',
      'ana-',
      'ab',
      'a'.repeat(65),
      'ana.luz',
      'ana luz',
      'ab--cd',
      'xn--abc',
      'josé',
      '💩💩💩',
      'ana‍',
      '@@ana',
      '',
      null,
      undefined,
    ]) {
      expect(toHandle(bad), String(bad)).toBeNull()
    }
  })

  it('accepts 3 and 64 characters', () => {
    expect(toHandle('abc')).toBe('abc')
    expect(toHandle('a'.repeat(64))).toBe('a'.repeat(64))
  })

  it('tells a stored handle from input that needs normalising', () => {
    expect(isHandle('ana')).toBe(true)
    expect(isHandle('Ana')).toBe(false)
    expect(isHandle('@ana')).toBe(false)
    expect(isHandle('ana_luz')).toBe(false)
    expect(isHandle(null)).toBe(false)
  })
})

describe('handleId', () => {
  it('is keccak256 of the prefix and the label', () => {
    expect(handleId('ana')).toBe(id('cofferdam-handle-v1:ana'))
    expect(handleId('ana')).toBe(keccak256(toUtf8Bytes('cofferdam-handle-v1:ana')))
    expect(handleId('ana')).toBe('0x' + Buffer.from(keccak256(Buffer.from('cofferdam-handle-v1:ana')).slice(2), 'hex').toString('hex'))
    expect(handleId('ana')).not.toBe(handleId('ana-luz'))
  })

  it('refuses anything not in stored form', () => {
    expect(() => handleId('Ana')).toThrow('stored form')
    expect(() => handleId('@ana')).toThrow('stored form')
    expect(() => handleId('ab')).toThrow('stored form')
  })
})

describe('EIP-712 types', () => {
  const owner = Wallet.createRandom()
  const anchor = handleAnchorDomain(84532, '0x' + '12'.repeat(20))
  const registry = handleRegistryDomain(84532)
  const msg = { handleId: handleId('ana'), nonce: 3n, deadline: 1_900_000_000 }

  it('write canonical type strings', () => {
    expect(handleTypeString('Release')).toBe('Release(bytes32 handleId,uint256 nonce,uint64 deadline)')
    expect(handleTypeString('RegistrarClaim')).toBe('RegistrarClaim(bytes32 handleId,address owner,uint64 serial,uint256 nonce,uint64 deadline)')
    expect(handleTypeString('OwnerClaim')).toBe('OwnerClaim(bytes32 handleId,bytes metaAddress,uint64 serial)')
    for (const t of [...Object.keys(HANDLE_ANCHOR_TYPES), ...Object.keys(HANDLE_REGISTRY_TYPES)] as const) {
      const fields = (HANDLE_ANCHOR_TYPES as any)[t] ?? (HANDLE_REGISTRY_TYPES as any)[t]
      expect(TypedDataEncoder.from({ [t]: fields }).encodeType(t)).toBe(handleTypeString(t as any))
    }
  })

  it('cover every signed call 0086 names, and the assumed unfreeze', () => {
    expect(Object.keys(HANDLE_ANCHOR_TYPES).sort()).toEqual(
      [
        'Advance',
        'AdvanceAccept',
        'Cancel',
        'Hold',
        'OwnerClaim',
        'RegistrarAdvance',
        'RegistrarClaim',
        'RegistrarUnfreeze',
        'Release',
        'RenewHold',
        'SetMetaAddress',
        'TransferOwner',
        'TransferOwnerAccept',
        'Unfreeze',
        'Veto',
      ].sort(),
    )
    expect(Object.isFrozen(HANDLE_ANCHOR_TYPES)).toBe(true)
  })

  it('sign so that ethers verifies and the signer recovers', () => {
    const pk = Buffer.from(owner.privateKey.slice(2), 'hex')
    const sig = signHandleTypedData(pk, anchor, 'Release', msg)
    expect(verifyTypedData(anchor, { Release: HANDLE_ANCHOR_TYPES.Release }, msg, sig)).toBe(owner.address)
    expect(recoverHandleTypedDataSigner(anchor, 'Release', msg, sig)).toBe(owner.address)
    // another message or domain recovers someone else
    expect(recoverHandleTypedDataSigner(anchor, 'Release', { ...msg, nonce: 4n }, sig)).not.toBe(owner.address)
    expect(recoverHandleTypedDataSigner(handleAnchorDomain(8453, '0x' + '12'.repeat(20)), 'Release', msg, sig)).not.toBe(owner.address)
    expect(recoverHandleTypedDataSigner(anchor, 'Release', msg, '0x1234')).toBeNull()
  })

  it('refuse a message with a missing or an extra field, and the wrong domain', () => {
    expect(() => handleTypedDataDigest(anchor, 'Release', { handleId: msg.handleId, nonce: 1 })).toThrow('missing deadline')
    expect(() => handleTypedDataDigest(anchor, 'Release', { ...msg, extra: 1 })).toThrow('no field extra')
    expect(() => handleTypedDataDigest(registry, 'Release', msg)).toThrow('CofferdamHandleAnchor domain')
    expect(() => handleTypedDataDigest(anchor, 'ReleaseHandle', { handleId: msg.handleId, serial: 1, nonce: '0x' + '00'.repeat(32), expiresAt: 1 })).toThrow(
      'CofferdamHandleRegistry domain',
    )
    expect(() => handleTypedDataDigest({ ...anchor, version: '2' }, 'Release', msg)).toThrow('version 1')
    expect(() => handleTypedDataDigest({ ...anchor, verifyingContract: null }, 'Release', msg)).toThrow('names verifyingContract')
    expect(() => handleTypedDataDigest({ ...anchor, chainId: null }, 'Release', msg)).toThrow('names a chain')
    expect(() =>
      handleTypedDataDigest({ ...registry, verifyingContract: '0x' + '12'.repeat(20) }, 'ReleaseHandle', {
        handleId: msg.handleId,
        serial: 1,
        nonce: '0x' + '00'.repeat(32),
        expiresAt: 1,
      }),
    ).toThrow('names no verifyingContract')
    expect(() => handleTypedDataDigest(anchor, 'Nope' as any, msg)).toThrow('unknown primary type')
    expect(() => handleTypedDataDigest(anchor, 'toString' as any, msg)).toThrow('unknown primary type')
  })

  it('give a registry domain with no contract', () => {
    expect(registry).toEqual({ name: 'CofferdamHandleRegistry', version: '1', chainId: 84532 })
    expect(anchor.verifyingContract).toBe('0x1212121212121212121212121212121212121212')
  })
})
