// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

// `sendTransaction` over the relay with the chain stubbed at the ethers
// provider: the op's own success decides (decision 0080 (3)), and
// `preVerificationGas: 'l1-fee'` is estimated before the hash is signed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AbiCoder, FeeData, Interface, JsonRpcProvider, type TransactionReceipt } from 'ethers'
import {
  COFFERDAM_IDENTITY_REGISTRY_ABI,
  ENTRY_POINT_EVENTS_ABI,
  GAS_PRICE_ORACLE,
  NativeAccountProvider,
  UserOperationFailedError,
  encodeBindCall,
  identityRevertName,
  type PackedUserOperationJson,
} from '../src/index.js'

const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
const ACCOUNT = '0x80967a159A00dcabe2DeAF86b68249acfc45C265'
const REGISTRY = '0x00000000000000000000000000000000000c0ffe'
const TX = '0x' + '01'.repeat(32)
const coder = AbiCoder.defaultAbiCoder()
const EP_IFACE = new Interface([
  'function getNonce(address sender, uint192 key) view returns (uint256 nonce)',
  'function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)',
])
const ORACLE = new Interface(['function getL1Fee(bytes data) view returns (uint256)'])
const EVENTS = new Interface(ENTRY_POINT_EVENTS_ABI as unknown as string[])
const REGISTRY_IFACE = new Interface(COFFERDAM_IDENTITY_REGISTRY_ABI as unknown as string[])

/** The op hash the stub returns: a function of the op's preVerificationGas, so a test sees which op was hashed. */
function hashFor(pvg: bigint): string {
  return '0x' + pvg.toString(16).padStart(64, '0')
}

function stubChain(opts: { success: boolean; revert?: string; l1Fee?: bigint }) {
  const hashed: bigint[] = []
  vi.spyOn(JsonRpcProvider.prototype, 'getCode').mockResolvedValue('0x01')
  vi.spyOn(JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue(new FeeData(10_000_000n, null, null))
  vi.spyOn(JsonRpcProvider.prototype, 'call').mockImplementation(async (tx) => {
    const to = String(tx.to).toLowerCase()
    const data = String(tx.data)
    if (to === GAS_PRICE_ORACLE.toLowerCase()) {
      ORACLE.decodeFunctionData('getL1Fee', data)
      return coder.encode(['uint256'], [opts.l1Fee ?? 0n])
    }
    const fn = EP_IFACE.parseTransaction({ data })!
    if (fn.name === 'getNonce') return coder.encode(['uint256'], [5n])
    const pvg = fn.args[0][5] as bigint
    hashed.push(pvg)
    return coder.encode(['bytes32'], [hashFor(pvg)])
  })
  vi.spyOn(JsonRpcProvider.prototype, 'waitForTransaction').mockImplementation(async () => {
    const hash = hashFor(hashed[hashed.length - 1] ?? 0n)
    const logs = []
    if (opts.revert) {
      const ev = EVENTS.encodeEventLog('UserOperationRevertReason', [hash, ACCOUNT, 5n, opts.revert])
      logs.push({ address: EP, ...ev })
    }
    const ev = EVENTS.encodeEventLog('UserOperationEvent', [hash, ACCOUNT, '0x' + '00'.repeat(20), 5n, opts.success, 1n, 1n])
    logs.push({ address: EP, ...ev })
    return { hash: TX, status: 1, blockNumber: 10, logs } as unknown as TransactionReceipt
  })
  return { hashed }
}

function provider(fetchImpl: typeof fetch, extra: { preVerificationGas?: bigint | 'l1-fee' } = {}) {
  return new NativeAccountProvider({
    scope: 'test',
    rpcUrl: 'http://127.0.0.1:1',
    chainId: 8453,
    contracts: { factory: '0x' + '0f'.repeat(20), passkeyModule: '0x' + '0e'.repeat(20) },
    accountAddress: ACCOUNT,
    relayerUrl: 'https://plane.test',
    fetch: fetchImpl,
    usePaymaster: false,
    ...extra,
  })
}

function relay(sent: PackedUserOperationJson[], receipt = 'success'): typeof fetch {
  return async (_url, init) => {
    sent.push((JSON.parse(String(init?.body)) as { userOp: PackedUserOperationJson }).userOp)
    return new Response(JSON.stringify({ ok: true, txHash: TX, entryPoint: EP, receipt }), { status: 202 })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NativeAccountProvider.sendTransaction checks the op itself', () => {
  it('resolves when the op succeeded', async () => {
    stubChain({ success: true })
    const sent: PackedUserOperationJson[] = []
    const receipt = await provider(relay(sent)).sendTransaction({ to: REGISTRY, data: encodeBindCall(ACCOUNT, '0x') })
    expect(receipt.hash).toBe(TX)
    expect(sent[0].preVerificationGas).toBe('0')
  })

  it('throws when the mined op reverted, even if the plane answered success', async () => {
    const revert = REGISTRY_IFACE.encodeErrorResult('WrongBoundDigest', [])
    stubChain({ success: false, revert })
    const err = await provider(relay([], 'success'))
      .sendTransaction({ to: REGISTRY, data: encodeBindCall(ACCOUNT, '0x') })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UserOperationFailedError)
    expect((err as UserOperationFailedError).reason).toBe('reverted')
    expect(identityRevertName((err as UserOperationFailedError).revertData)).toBe('WrongBoundDigest')
  })

  it('checks a pending answer the same way', async () => {
    stubChain({ success: false })
    await expect(provider(relay([], 'pending')).sendTransaction({ to: REGISTRY })).rejects.toBeInstanceOf(UserOperationFailedError)
  })

  it("estimates preVerificationGas from the L1 fee before hashing, and signs the op it sends", async () => {
    const { hashed } = stubChain({ success: true, l1Fee: 10n ** 12n })
    const sent: PackedUserOperationJson[] = []
    await provider(relay(sent), { preVerificationGas: 'l1-fee' }).sendTransaction({ to: REGISTRY, data: encodeBindCall(ACCOUNT, '0x') })
    const pvg = BigInt(sent[0].preVerificationGas)
    // 1e12 wei × 137.5% at 1e7 wei per gas = 137,500 gas, plus the bundle's calldata gas.
    expect(pvg).toBeGreaterThan(137_500n + 21_000n)
    expect(pvg).toBeLessThan(137_500n + 200_000n)
    expect(hashed).toEqual([pvg])
  })

  it('sends a fixed preVerificationGas as configured', async () => {
    stubChain({ success: true })
    const sent: PackedUserOperationJson[] = []
    await provider(relay(sent), { preVerificationGas: 50_000n }).sendTransaction({ to: REGISTRY })
    expect(sent[0].preVerificationGas).toBe('50000')
  })
})
