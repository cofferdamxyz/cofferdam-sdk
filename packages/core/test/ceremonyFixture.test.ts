import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { id, keccak256, recoverAddress, TypedDataEncoder, verifyTypedData } from 'ethers'
import { describe, expect, it } from 'vitest'
import { buildCeremonyFixture } from './fixtures/buildCeremonyFixture.js'

// The shared fixture of decision 0090 item 5. The account contract's, the
// attester's and the plane's tests read it; this test fails when the SDK
// drifts from it. Rewrite with: WRITE_CEREMONY_FIXTURE=1 yarn test ceremonyFixture
const PATH = fileURLToPath(new URL('./fixtures/ceremonyTypes.json', import.meta.url))

const built = JSON.parse(JSON.stringify(buildCeremonyFixture())) as any

if (process.env.WRITE_CEREMONY_FIXTURE === '1') {
  writeFileSync(PATH, JSON.stringify(built, null, 2) + '\n')
}

describe('ceremonyTypes.json', () => {
  it('is what the SDK builds today', () => {
    expect(existsSync(PATH)).toBe(true)
    expect(JSON.parse(readFileSync(PATH, 'utf8'))).toEqual(built)
  })

  it('pins the typehash as keccak256 of its type string, in the fields order', () => {
    expect(built.typehash).toBe(id(built.typeString))
    expect(built.typeString).toBe(`CeremonyAttestation(${built.fields.map((f: any) => `${f.type} ${f.name}`).join(',')})`)
  })

  it('has digests ethers computes the same way, each signed by the fixture attester', () => {
    const types = { CeremonyAttestation: built.fields }
    for (const v of built.vectors) {
      expect(TypedDataEncoder.hashDomain(v.domain)).toBe(v.domainSeparator)
      expect(keccak256('0x1901' + v.domainSeparator.slice(2) + v.structHash.slice(2))).toBe(v.digest)
      expect(verifyTypedData(v.domain, types, v.message, v.signature)).toBe(built.attester.address)
      expect(recoverAddress(v.digest, v.signature)).toBe(built.attester.address)
      expect(v.message.action).toBe(built.actions[v.actionName])
      expect(BigInt('0x' + v.signature.slice(66, 130)) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true)
    }
  })
})
