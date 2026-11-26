import { computeAddress, getAddress, hashMessage, id, SigningKey, TypedDataEncoder } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  CEREMONY_ACTIONS,
  CEREMONY_TYPEHASH,
  ceremonyDigest,
  ceremonyDomain,
  recoverCeremonySigner,
  signCeremonyAttestation,
  type CeremonyAttestationMessage,
} from '../src/index.js'

const KEY = Uint8Array.from(Buffer.from(id('ceremony.test attester').slice(2), 'hex'))
const ATTESTER = new SigningKey(KEY)
const ATTESTER_ADDRESS = computeAddress(ATTESTER.publicKey)
const REGISTRY = getAddress('0x' + id('registry').slice(26))
const ACCOUNT = getAddress('0x' + id('account').slice(26))
const OTHER = getAddress('0x' + id('other account').slice(26))

const message: CeremonyAttestationMessage = {
  account: ACCOUNT,
  action: CEREMONY_ACTIONS['enroll-first-high'],
  newKeyHash: id('new key'),
  partnerId: id('offshoresync'),
  nonce: 0n,
  notBefore: 1_800_000_000n,
  expiry: 1_800_000_600n,
}

describe('ceremony attestation (decision 0090 item 5)', () => {
  it('pins the typehash and the actions the account hashes', () => {
    expect(CEREMONY_TYPEHASH).toBe(
      id('CeremonyAttestation(address account,bytes32 action,bytes32 newKeyHash,bytes32 partnerId,uint256 nonce,uint48 notBefore,uint48 expiry)'),
    )
    expect(CEREMONY_ACTIONS).toEqual({
      'enroll-first-high': id('enroll-first-high'),
      'replace-partner': id('replace-partner'),
      'recover-high': id('recover-high'),
    })
  })

  it('names the registry as verifyingContract, never the account', () => {
    const d = ceremonyDomain(8453, REGISTRY)
    expect(d).toEqual({ name: 'Cofferdam Ceremony', version: '1', chainId: 8453n, verifyingContract: REGISTRY })
    expect(ceremonyDigest(d, message)).not.toBe(ceremonyDigest(ceremonyDomain(8453, ACCOUNT), message))
    expect(ceremonyDigest(d, message)).not.toBe(ceremonyDigest(ceremonyDomain(84532, REGISTRY), message))
  })

  it('binds the account, so a signature for one account recovers to another address on another', () => {
    const d = ceremonyDomain(8453, REGISTRY)
    const sig = signCeremonyAttestation(KEY, d, message)
    expect(recoverCeremonySigner(d, message, sig)).toBe(ATTESTER_ADDRESS)
    expect(recoverCeremonySigner(d, { ...message, account: OTHER }, sig)).not.toBe(ATTESTER_ADDRESS)
  })

  it('is not an EIP-191 signature: personal_sign over the digest recovers to another address', () => {
    const d = ceremonyDomain(8453, REGISTRY)
    const digest = ceremonyDigest(d, message)
    const personal = ATTESTER.sign(hashMessage(Uint8Array.from(Buffer.from(digest.slice(2), 'hex')))).serialized
    expect(recoverCeremonySigner(d, message, signCeremonyAttestation(KEY, d, message))).toBe(ATTESTER_ADDRESS)
    expect(recoverCeremonySigner(d, message, personal)).not.toBe(ATTESTER_ADDRESS)
  })

  it('matches ethers over the raw types', () => {
    const d = ceremonyDomain(84532, REGISTRY)
    const types = {
      CeremonyAttestation: [
        { name: 'account', type: 'address' },
        { name: 'action', type: 'bytes32' },
        { name: 'newKeyHash', type: 'bytes32' },
        { name: 'partnerId', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'notBefore', type: 'uint48' },
        { name: 'expiry', type: 'uint48' },
      ],
    }
    expect(ceremonyDigest(d, message)).toBe(TypedDataEncoder.hash(d, types, message))
  })

  it('refuses a malformed message or another domain', () => {
    const d = ceremonyDomain(8453, REGISTRY)
    expect(() => ceremonyDigest(d, { ...message, action: id('send') })).toThrow(/ceremony action/)
    expect(() => ceremonyDigest(d, { ...message, newKeyHash: '0x1234' })).toThrow(/32 bytes/)
    expect(() => ceremonyDigest(d, { ...message, expiry: 1n << 48n })).toThrow(/out of range/)
    expect(() => ceremonyDigest(d, { ...message, expiry: message.notBefore })).toThrow(/after notBefore/)
    expect(() => ceremonyDigest(d, { ...message, account: '0xnope' })).toThrow()
    expect(() => ceremonyDigest({ ...d, name: 'Cofferdam Account' }, message)).toThrow(/ceremony domain/)
    expect(() => ceremonyDigest({ name: 'Cofferdam Ceremony', version: '1', chainId: 8453 }, message)).toThrow(/ceremony domain/)
  })

  it('answers null for a malformed signature', () => {
    expect(recoverCeremonySigner(ceremonyDomain(8453, REGISTRY), message, '0x1234')).toBeNull()
  })
})
