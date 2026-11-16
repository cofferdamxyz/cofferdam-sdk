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
  L1_LANE_FALLBACK_TIP,
  UserOpRelayError,
  UserOperationFailedError,
  encodeBindCall,
  identityRevertName,
  l1LaneGasPrice,
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

function stubChain(opts: {
  success: boolean
  revert?: string
  l1Fee?: bigint
  maxFeePerGas?: bigint
  priorityFee?: bigint
  gasPrice?: bigint
  /** What `eth_getLogs` finds of the op after a `relay_failed`: its event, or nothing. */
  landed?: boolean
}) {
  const hashed: bigint[] = []
  vi.spyOn(JsonRpcProvider.prototype, 'getCode').mockResolvedValue('0x01')
  vi.spyOn(JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue(
    new FeeData(
      opts.gasPrice ?? 10_000_000n,
      opts.maxFeePerGas ?? null,
      opts.maxFeePerGas !== undefined ? (opts.priorityFee ?? 1_000_000n) : null,
    ),
  )
  vi.spyOn(JsonRpcProvider.prototype, 'getBlockNumber').mockResolvedValue(500)
  vi.spyOn(JsonRpcProvider.prototype, 'getLogs').mockImplementation(async (filter) => {
    if (!opts.landed) return []
    const hash = hashFor(hashed[hashed.length - 1] ?? 0n)
    expect((filter as { topics: string[] }).topics[1]).toBe(hash)
    return [{ transactionHash: TX, removed: false }] as never
  })
  vi.spyOn(JsonRpcProvider.prototype, 'getTransactionReceipt').mockImplementation(async () => {
    const hash = hashFor(hashed[hashed.length - 1] ?? 0n)
    const ev = EVENTS.encodeEventLog('UserOperationEvent', [hash, ACCOUNT, '0x' + '00'.repeat(20), 5n, opts.success, 1n, 1n])
    return { hash: TX, status: 1, blockNumber: 499, logs: [{ address: EP, ...ev }] } as unknown as TransactionReceipt
  })
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

function relay(sent: PackedUserOperationJson[], receipt = 'success', bodies: Record<string, unknown>[] = []): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { userOp: PackedUserOperationJson }
    bodies.push(body)
    sent.push(body.userOp)
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
    const bodies: Record<string, unknown>[] = []
    const receipt = await provider(relay(sent, 'success', bodies)).sendTransaction({ to: REGISTRY, data: encodeBindCall(ACCOUNT, '0x') })
    expect(receipt.hash).toBe(TX)
    expect(sent[0].preVerificationGas).toBe('0')
    expect(bodies[0].chainId).toBe(8453)
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

  it("prices an 'l1-fee' op at ethers' maxFeePerGas when eth_gasPrice is under it (the plane's fee floor)", async () => {
    stubChain({ success: true, l1Fee: 10n ** 12n, maxFeePerGas: 25_000_000n })
    const sent: PackedUserOperationJson[] = []
    await provider(relay(sent), { preVerificationGas: 'l1-fee' }).sendTransaction({ to: REGISTRY })
    const fees = BigInt(sent[0].gasFees)
    expect(fees & ((1n << 128n) - 1n)).toBe(25_000_000n) // maxFeePerGas
    expect(fees >> 128n).toBe(25_000_000n) // maxPriorityFeePerGas: the effective price is maxFeePerGas
    // The default lane keeps eth_gasPrice.
    vi.restoreAllMocks()
    stubChain({ success: true, maxFeePerGas: 25_000_000n })
    const sepolia: PackedUserOperationJson[] = []
    await provider(relay(sepolia)).sendTransaction({ to: REGISTRY })
    expect(BigInt(sepolia[0].gasFees) & ((1n << 128n) - 1n)).toBe(10_000_000n)
  })

  it('sends a fixed preVerificationGas as configured', async () => {
    stubChain({ success: true })
    const sent: PackedUserOperationJson[] = []
    await provider(relay(sent), { preVerificationGas: 50_000n }).sendTransaction({ to: REGISTRY })
    expect(sent[0].preVerificationGas).toBe('50000')
  })
})

describe("'l1-fee' price (the mainnet test lane caps maxFeePerGas at 1 gwei)", () => {
  it("never uses ethers' 1 gwei stand-in tip: 2 × base fee + eth_gasPrice's tip", async () => {
    // eth_maxPriorityFeePerGas failed: ethers reports 2 × 10M + 1 gwei.
    stubChain({ success: true, gasPrice: 10_000_100n, maxFeePerGas: 20_000_000n + 10n ** 9n, priorityFee: 10n ** 9n })
    const sent: PackedUserOperationJson[] = []
    await provider(relay(sent), { preVerificationGas: 'l1-fee' }).sendTransaction({ to: REGISTRY })
    expect(BigInt(sent[0].gasFees) & ((1n << 128n) - 1n)).toBe(20_000_100n)
  })

  it('takes the fallback tip when eth_gasPrice is at or under the base fee, and eth_gasPrice without fee data', () => {
    expect(l1LaneGasPrice({ gasPrice: 9n, maxFeePerGas: 21n, maxPriorityFeePerGas: 1n })).toBe(20n + L1_LANE_FALLBACK_TIP)
    expect(l1LaneGasPrice({ gasPrice: 12n, maxFeePerGas: 21n, maxPriorityFeePerGas: 1n })).toBe(22n)
    expect(l1LaneGasPrice({ gasPrice: 7n, maxFeePerGas: null, maxPriorityFeePerGas: null })).toBe(7n)
  })
})

describe('relay_failed: the op is looked up before a failure is reported', () => {
  function failing(code: string, status: number): typeof fetch {
    return async () => new Response(JSON.stringify({ ok: false, error: code, message: 'x' }), { status })
  }

  it('resolves with the receipt when the op landed despite the 502', async () => {
    stubChain({ success: true, landed: true })
    const receipt = await provider(failing('relay_failed', 502)).sendTransaction({ to: REGISTRY })
    expect(receipt.hash).toBe(TX)
  })

  it('throws reverted when the landed op reverted', async () => {
    stubChain({ success: false, landed: true })
    const err = await provider(failing('relay_failed', 502)).sendTransaction({ to: REGISTRY }).catch((e: unknown) => e)
    expect((err as UserOperationFailedError).reason).toBe('reverted')
  })

  it('throws unknown when the op is not found (it may still land)', async () => {
    stubChain({ success: true, landed: false })
    const err = await provider(failing('relay_failed', 502)).sendTransaction({ to: REGISTRY }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UserOperationFailedError)
    expect((err as UserOperationFailedError).reason).toBe('unknown')
  })

  it('passes refusals that sent nothing through unchanged', async () => {
    for (const [code, status] of [['preflight_unavailable', 503], ['fee_too_high', 400], ['rate_limited', 429]] as const) {
      stubChain({ success: true, landed: true })
      const err = await provider(failing(code, status)).sendTransaction({ to: REGISTRY }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(UserOpRelayError)
      expect((err as UserOpRelayError).code).toBe(code)
      vi.restoreAllMocks()
    }
  })
})
