import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { computeAddress, id, keccak256, recoverAddress, SigningKey, TypedDataEncoder, verifyTypedData } from 'ethers'
import { describe, expect, it } from 'vitest'
import { buildHandleFixture } from './fixtures/buildHandleFixture.js'

// The shared fixture of decision 0086 step 1. The anchor contract's and the
// plane's tests read it; this test fails when the SDK drifts from it.
// Rewrite with: WRITE_HANDLE_FIXTURE=1 yarn test handleFixture
const PATH = fileURLToPath(new URL('./fixtures/handleAnchorTypes.json', import.meta.url))

const built = JSON.parse(JSON.stringify(buildHandleFixture())) as any

if (process.env.WRITE_HANDLE_FIXTURE === '1') {
  writeFileSync(PATH, JSON.stringify(built, null, 2) + '\n')
}

describe('handleAnchorTypes.json', () => {
  it('is what the SDK builds today', () => {
    expect(existsSync(PATH)).toBe(true)
    expect(JSON.parse(readFileSync(PATH, 'utf8'))).toEqual(built)
  })

  it('pins every typehash as keccak256 of its type string', () => {
    for (const domain of ['anchor', 'registry', 'handshake']) {
      for (const [name, t] of Object.entries<any>(built.eip712[domain].types)) {
        expect(t.typeString.startsWith(`${name}(`)).toBe(true)
        expect(t.typeHash).toBe(id(t.typeString))
        expect(t.typeString).toBe(`${name}(${t.fields.map((f: any) => `${f.type} ${f.name}`).join(',')})`)
      }
    }
  })

  it('has domain separators ethers computes the same way', () => {
    for (const domain of ['anchor', 'registry', 'handshake']) {
      const { separator, ...d } = built.eip712[domain].domain
      expect(TypedDataEncoder.hashDomain(d)).toBe(separator)
    }
  })

  it('signs one message per primary type, each recovering to its role', () => {
    const anchorTypes = Object.keys(built.eip712.anchor.types)
    const registryTypes = Object.keys(built.eip712.registry.types)
    expect(built.signed.map((s: any) => s.primaryType)).toEqual([...anchorTypes, ...registryTypes])
    for (const s of built.signed) {
      const { separator: _s, ...domain } = built.eip712[s.domain].domain
      const types = { [s.primaryType]: built.eip712[s.domain].types[s.primaryType].fields }
      expect(verifyTypedData(domain, types, s.message, s.signature)).toBe(s.signerAddress)
      expect(recoverAddress(s.digest, s.signature)).toBe(s.signerAddress)
      expect(built.keys[s.signer].address).toBe(s.signerAddress)
      // digest = keccak256(0x1901 ‖ domainSeparator ‖ structHash)
      expect(keccak256('0x1901' + built.eip712[s.domain].domain.separator.slice(2) + s.structHash.slice(2))).toBe(s.digest)
      // low s
      expect(BigInt('0x' + s.signature.slice(66, 130)) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true)
    }
  })

  it('has private keys that match their addresses', () => {
    for (const k of Object.values<any>(built.keys)) expect(computeAddress(k.privateKey)).toBe(k.address)
  })

  it('has stealth vectors an ethers-only reference reproduces', () => {
    const { metaAddress, factory } = built.stealth
    const S = '0x' + metaAddress.slice(2, 68)
    const V = '0x' + metaAddress.slice(68)
    for (const v of [...built.stealth.vectors, ...built.stealth.selfDerived]) {
      const shared = SigningKey.computePublicKey(new SigningKey(v.ephemeralPrivateKey).computeSharedSecret(V), true)
      const h = keccak256(shared)
      expect(h).toBe(v.sharedSecretHash)
      expect(Number.parseInt(h.slice(2, 4), 16)).toBe(v.viewTag)
      expect(SigningKey.computePublicKey(v.ephemeralPrivateKey, true)).toBe(v.ephemeralPublicKey)
      const P = SigningKey.addPoints(S, SigningKey.computePublicKey(h, true))
      expect(computeAddress(P)).toBe(v.signer)
      const salt = '0x' + v.signer.slice(2).toLowerCase().padStart(64, '0')
      const create2 = keccak256('0xff' + factory.address.slice(2) + salt.slice(2) + factory.initCodeHash.slice(2))
      expect(('0x' + create2.slice(26)).toLowerCase()).toBe(v.account.toLowerCase())
      if (v.stealthPrivateKey) {
        expect(computeAddress(v.stealthPrivateKey)).toBe(v.signer)
        expect(v.signerPublicKey).toBe(SigningKey.computePublicKey(P, true))
      }
    }
  })
})
