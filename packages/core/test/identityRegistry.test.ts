// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { AbiCoder, Interface, keccak256, toUtf8Bytes, type ContractRunner } from 'ethers'
import {
  COFFERDAM_IDENTITY_REGISTRY_ABI,
  CofferdamIdentityRegistryClient,
  IDENTITY_ACTIONS,
  IDENTITY_ACTION_TAGS,
  IdentityRegistryError,
  encodeBindCall,
  encodeZkpEvidence,
  identityDigest,
  identityRevertName,
  zkpCustomData,
  zkpEvidenceFromParams,
  type IdentityAction,
  type ZkpSolidityParams,
} from '../src/index.js'
// Copied verbatim from base-contracts `test/fixtures/identity-digest.json`
// (PR #21, branch claude/zkp-registry-108211 at 8011b6b), where it is computed
// with viem and checked against the contract. Copy it again on any change
// there; a drift fails here.
import fixture from './fixtures/identity-digest.json' with { type: 'json' }
// Error selectors read from the same branch's compiled artifacts.
import errorFixture from './fixtures/identity-errors.json' with { type: 'json' }

const REGISTRY = '0x00000000000000000000000000000000000c0ffe'
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const ADAPTER = '0x2222222222222222222222222222222222222222'
const IFACE = new Interface(COFFERDAM_IDENTITY_REGISTRY_ABI as unknown as string[])

describe('identity digest (decision 0080, base-contracts PR #21 fixture)', () => {
  it('uses the fixture tags', () => {
    expect(IDENTITY_ACTION_TAGS).toEqual(fixture.tags)
    for (const action of Object.keys(fixture.tags) as IdentityAction[]) {
      expect(IDENTITY_ACTIONS[action]).toBe(keccak256(toUtf8Bytes(fixture.tags[action])))
    }
  })

  it.each(fixture.vectors)('matches the $action vector on chain $chainId', (v) => {
    const digest = identityDigest(v.action as IdentityAction, BigInt(v.chainId), v.registry, v.account, BigInt(v.nonce))
    expect(digest).toBe(v.digest)
    expect(zkpCustomData(digest)).toBe(v.customData)
  })

  it('custom_data is the lowercase 66-character hex of the digest, and refuses anything else', () => {
    const upper = '0x' + 'AB'.repeat(32)
    expect(zkpCustomData(upper)).toBe('0x' + 'ab'.repeat(32))
    expect(zkpCustomData(upper)).toHaveLength(66)
    expect(() => zkpCustomData('ab'.repeat(32))).toThrow()
    expect(() => zkpCustomData('0x' + 'ab'.repeat(31))).toThrow()
  })
})

describe('ZKPassport evidence', () => {
  const proof = {
    vkeyHash: '0x' + 'ab'.repeat(32),
    proof: '0x0102030405',
    publicInputs: ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32)],
    committedInputs: '0x08' + 'cd'.repeat(40),
  }

  it('is abi.encode(bytes32, bytes, bytes32[], bytes), pinned by a vector computed with viem', () => {
    const evidence = encodeZkpEvidence(proof)
    expect((evidence.length - 2) / 2).toBe(416)
    expect(keccak256(evidence)).toBe('0x9259bc6db56922c98bd6c8d618bec76165e8fccc87c962a1ad950541ff4ba493')
  })

  it('takes only the proof fields from the verifier parameters', () => {
    const params: ZkpSolidityParams = {
      version: '0x0000001500010000000000000000000000000000000000000000000000000000',
      proofVerificationData: { vkeyHash: proof.vkeyHash, proof: proof.proof, publicInputs: proof.publicInputs },
      committedInputs: proof.committedInputs,
      serviceConfig: { validityPeriodInSeconds: 3600, domain: 'cofferdam.xyz', scope: 'x', devMode: false },
    }
    expect(zkpEvidenceFromParams(params)).toBe(encodeZkpEvidence(proof))
  })

  it('refuses a vkey hash that is not 32 bytes', () => {
    expect(() => encodeZkpEvidence({ ...proof, vkeyHash: '0x1234' })).toThrow()
  })
})

describe('registry calls', () => {
  it('bind calldata is bind(address,bytes)', () => {
    const data = encodeBindCall(ADAPTER, '0xdeadbeef')
    expect(data.slice(0, 10)).toBe('0x9cef18b2')
    const [adapter, evidence] = IFACE.decodeFunctionData('bind', data)
    expect(String(adapter).toLowerCase()).toBe(ADAPTER)
    expect(evidence).toBe('0xdeadbeef')
  })

  it("declares every error the contracts can revert with in a call, with base-contracts' selectors", () => {
    const declared = new Map<string, string>()
    IFACE.forEachError((e) => declared.set(e.name, e.selector))
    for (const [name, selector] of Object.entries(errorFixture.selectors)) {
      if (errorFixture.constructorOnly.includes(name)) {
        expect(declared.has(name), name).toBe(false)
        continue
      }
      expect(declared.get(name), name).toBe(selector)
      expect(identityRevertName(selector + '00'.repeat(64))).toBe(name)
    }
    expect([...declared.keys()].every((n) => n in errorFixture.selectors)).toBe(true)
  })

  it('names registry and adapter reverts without their arguments', () => {
    const data = IFACE.encodeErrorResult('IdentifierAlreadyBound', ['0x' + '99'.repeat(32), ACCOUNT])
    expect(identityRevertName(data)).toBe('IdentifierAlreadyBound')
    expect(identityRevertName(IFACE.encodeErrorResult('WrongBoundDigest', []))).toBe('WrongBoundDigest')
    expect(identityRevertName('0x12345678')).toBe('0x12345678')
    expect(identityRevertName('0x')).toBe('empty')
    expect(identityRevertName(undefined)).toBe('empty')
    expect(identityRevertName('0x08c379a0' + '00'.repeat(64))).toBe('Error')
  })
})

/** A runner that answers `eth_call` for the registry's views, or reverts with `revert`. */
function fakeRunner(revert?: string): ContractRunner & { calls: string[] } {
  const calls: string[] = []
  const coder = AbiCoder.defaultAbiCoder()
  return {
    provider: null,
    calls,
    async call(tx) {
      const data = String(tx.data)
      const fn = IFACE.parseTransaction({ data })!
      calls.push(fn.name)
      if (revert) {
        throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: revert })
      }
      switch (fn.name) {
        case 'nonces':
          return coder.encode(['uint256'], [2n])
        case 'digest':
          return coder.encode(['bytes32'], [identityDigest('bind', 8453n, REGISTRY, fn.args[1] as string, 2n)])
        case 'isAccountBound':
          return coder.encode(['bool'], [true])
        case 'check':
          return coder.encode(['bytes32', 'address'], ['0x' + '77'.repeat(32), '0x' + '00'.repeat(20)])
        default:
          throw new Error(`unexpected ${fn.name}`)
      }
    },
  } as ContractRunner & { calls: string[] }
}

describe('CofferdamIdentityRegistryClient', () => {
  it('reads digest, custom_data, nonces, isAccountBound and check', async () => {
    const runner = fakeRunner()
    const client = new CofferdamIdentityRegistryClient({ address: REGISTRY, runner })
    const expected = identityDigest('bind', 8453n, REGISTRY, ACCOUNT, 2n)
    expect(await client.digest('bind', ACCOUNT)).toBe(expected)
    expect(await client.customData('bind', ACCOUNT)).toBe(expected)
    expect(await client.nonces(ACCOUNT)).toBe(2n)
    expect(await client.isAccountBound(ACCOUNT)).toBe(true)
    expect(await client.check('bind', ACCOUNT, ADAPTER, '0x')).toEqual({
      identifier: '0x' + '77'.repeat(32),
      counterpart: '0x' + '00'.repeat(20),
    })
    expect(runner.calls).toEqual(['digest', 'digest', 'nonces', 'isAccountBound', 'check'])
  })

  it('passes the action hash to digest and check', async () => {
    let seen: unknown[] = []
    const runner = {
      provider: null,
      async call(tx: { data?: string | null }) {
        const fn = IFACE.parseTransaction({ data: String(tx.data) })!
        seen = [...fn.args]
        return AbiCoder.defaultAbiCoder().encode(['bytes32'], ['0x' + '00'.repeat(32)])
      },
    } as unknown as ContractRunner
    await new CofferdamIdentityRegistryClient({ address: REGISTRY, runner }).digest('relink', ACCOUNT)
    expect(seen[0]).toBe(IDENTITY_ACTIONS.relink)
  })

  it('turns a check revert into the error name alone', async () => {
    const revert = IFACE.encodeErrorResult('IdentifierAlreadyBound', ['0x' + '99'.repeat(32), ACCOUNT])
    const client = new CofferdamIdentityRegistryClient({ address: REGISTRY, runner: fakeRunner(revert) })
    const err = await client.check('bind', ACCOUNT, ADAPTER, '0x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IdentityRegistryError)
    expect((err as IdentityRegistryError).errorName).toBe('IdentifierAlreadyBound')
    expect((err as Error).message).not.toContain('99'.repeat(32))
  })

  it('reports a call that could not run apart from a revert, without the request', async () => {
    const evidence = '0x' + '5e'.repeat(64)
    const failing = (err: Error) =>
      ({
        provider: null,
        async call() {
          throw err
        },
      }) as unknown as ContractRunner
    // ethers reports a JSON-RPC error on eth_call as CALL_EXCEPTION with data null.
    const rpc = Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null, info: { evidence } })
    for (const err of [rpc, new Error(`network down ${evidence}`)]) {
      const client = new CofferdamIdentityRegistryClient({ address: REGISTRY, runner: failing(err) })
      const got = await client.check('bind', ACCOUNT, ADAPTER, evidence).catch((e: unknown) => e)
      expect(got).not.toBeInstanceOf(IdentityRegistryError)
      expect((got as Error).message).toContain('could not run')
      expect((got as Error).message).not.toContain('5e5e')
      expect((got as { cause?: unknown }).cause).toBeUndefined()
    }
  })

  it('reads a revert without data as a refusal named empty', async () => {
    const client = new CofferdamIdentityRegistryClient({ address: REGISTRY, runner: fakeRunner('0x') })
    await expect(client.check('bind', ACCOUNT, ADAPTER, '0x')).rejects.toMatchObject({ errorName: 'empty' })
  })
})
