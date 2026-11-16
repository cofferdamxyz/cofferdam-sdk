// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { Interface, type Log, type TransactionReceipt } from 'ethers'
import {
  COFFERDAM_IDENTITY_REGISTRY_ABI,
  ENTRY_POINT_EVENTS_ABI,
  UserOperationFailedError,
  confirmUserOperation,
  identityRevertName,
  userOperationOutcome,
  type ConfirmUserOperationOptions,
} from '../src/index.js'

const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
const SENDER = '0x80967a159A00dcabe2DeAF86b68249acfc45C265'
const OP = '0x' + 'aa'.repeat(32)
const OTHER_OP = '0x' + 'bb'.repeat(32)
const TX = '0x' + '01'.repeat(32)
const EARLIER_TX = '0x' + '02'.repeat(32)
const EVENTS = new Interface(ENTRY_POINT_EVENTS_ABI as unknown as string[])
const REGISTRY = new Interface(COFFERDAM_IDENTITY_REGISTRY_ABI as unknown as string[])
const WRONG_DIGEST = REGISTRY.encodeErrorResult('WrongBoundDigest', [])

type L = Pick<Log, 'address' | 'topics' | 'data'>

function opEvent(hash: string, success: boolean, address = EP): L {
  const { topics, data } = EVENTS.encodeEventLog('UserOperationEvent', [hash, SENDER, '0x' + '00'.repeat(20), 0n, success, 1n, 1n])
  return { address, topics, data }
}
function revertEvent(hash: string, reason: string): L {
  const { topics, data } = EVENTS.encodeEventLog('UserOperationRevertReason', [hash, SENDER, 0n, reason])
  return { address: EP, topics, data }
}
function prefundEvent(hash: string): L {
  const { topics, data } = EVENTS.encodeEventLog('UserOperationPrefundTooLow', [hash, SENDER, 0n])
  return { address: EP, topics, data }
}

describe('userOperationOutcome', () => {
  it('reads success for the op hash and skips other ops and other contracts', () => {
    expect(userOperationOutcome([opEvent(OTHER_OP, false), opEvent(OP, true)], EP, OP)).toEqual({ status: 'success' })
    expect(userOperationOutcome([opEvent(OP, true, SENDER)], EP, OP)).toEqual({ status: 'missing' })
    expect(userOperationOutcome([], EP, OP)).toEqual({ status: 'missing' })
  })

  it('reads a reverted op with its revert data, decodable by name', () => {
    const out = userOperationOutcome([revertEvent(OP, WRONG_DIGEST), opEvent(OP, false)], EP, OP)
    expect(out).toEqual({ status: 'reverted', stage: 'execution', revertData: WRONG_DIGEST })
    expect(identityRevertName(out.status === 'reverted' ? out.revertData : null)).toBe('WrongBoundDigest')
  })

  it('reads a prefund failure and a revert without a reason', () => {
    expect(userOperationOutcome([prefundEvent(OP), opEvent(OP, false)], EP, OP)).toEqual({
      status: 'reverted',
      stage: 'prefund',
      revertData: '0x',
    })
    expect(userOperationOutcome([opEvent(OP, false)], EP, OP)).toEqual({ status: 'reverted', stage: 'execution', revertData: '0x' })
  })
})

function receipt(hash: string, status: number, logs: L[], blockNumber = 1_000): TransactionReceipt {
  return { hash, status, logs, blockNumber } as unknown as TransactionReceipt
}

function fakeChain(opts: {
  wait?: TransactionReceipt | null | Error
  logs?: Log[]
  receipts?: Record<string, TransactionReceipt>
}): ConfirmUserOperationOptions['provider'] & { getLogsCalls: unknown[] } {
  const getLogsCalls: unknown[] = []
  return {
    getLogsCalls,
    async waitForTransaction() {
      if (opts.wait instanceof Error) throw opts.wait
      return opts.wait ?? null
    },
    async getLogs(filter: unknown) {
      getLogsCalls.push(filter)
      return opts.logs ?? []
    },
    async getTransactionReceipt(hash: string) {
      return opts.receipts?.[hash] ?? null
    },
  } as unknown as ConfirmUserOperationOptions['provider'] & { getLogsCalls: unknown[] }
}

const base = { entryPoint: EP, userOpHash: OP, txHash: TX }

describe('confirmUserOperation', () => {
  it('resolves with the receipt when the op succeeded', async () => {
    const r = receipt(TX, 1, [opEvent(OP, true)])
    await expect(confirmUserOperation({ ...base, provider: fakeChain({ wait: r }) })).resolves.toBe(r)
  })

  it('throws reverted when the transaction succeeded but the op did not (a refused bind)', async () => {
    const chain = fakeChain({ wait: receipt(TX, 1, [revertEvent(OP, WRONG_DIGEST), opEvent(OP, false)]) })
    const err = await confirmUserOperation({ ...base, provider: chain }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UserOperationFailedError)
    expect(err).toMatchObject({ reason: 'reverted', stage: 'execution', revertData: WRONG_DIGEST, txHash: TX })
    expect(chain.getLogsCalls).toHaveLength(0)
  })

  it('throws unknown when no receipt comes in time, or the wait fails', async () => {
    await expect(confirmUserOperation({ ...base, provider: fakeChain({ wait: null }) })).rejects.toMatchObject({ reason: 'unknown' })
    await expect(confirmUserOperation({ ...base, provider: fakeChain({ wait: new Error('timeout') }) })).rejects.toMatchObject({
      reason: 'unknown',
    })
  })

  it('finds the op in an earlier transaction when handleOps reverted (the plane resent it)', async () => {
    const earlier = receipt(EARLIER_TX, 1, [opEvent(OP, true)], 995)
    const found = { ...opEvent(OP, true), transactionHash: EARLIER_TX, removed: false } as unknown as Log
    const chain = fakeChain({ wait: receipt(TX, 0, []), logs: [found], receipts: { [EARLIER_TX]: earlier } })
    await expect(confirmUserOperation({ ...base, provider: chain })).resolves.toBe(earlier)
    expect(chain.getLogsCalls[0]).toMatchObject({ address: EP, fromBlock: 800, toBlock: 1_000 })
    expect((chain.getLogsCalls[0] as { topics: string[] }).topics[1]).toBe(OP)
  })

  it('throws reverted when the earlier transaction ran the op and it reverted', async () => {
    const earlier = receipt(EARLIER_TX, 1, [revertEvent(OP, WRONG_DIGEST), opEvent(OP, false)], 995)
    const found = { ...opEvent(OP, false), transactionHash: EARLIER_TX, removed: false } as unknown as Log
    const chain = fakeChain({ wait: receipt(TX, 0, []), logs: [found], receipts: { [EARLIER_TX]: earlier } })
    await expect(confirmUserOperation({ ...base, provider: chain })).rejects.toMatchObject({ reason: 'reverted', txHash: EARLIER_TX })
  })

  it('throws not_executed when handleOps reverted and the op ran nowhere', async () => {
    const chain = fakeChain({ wait: receipt(TX, 0, [], 50) })
    await expect(confirmUserOperation({ ...base, provider: chain })).rejects.toMatchObject({ reason: 'not_executed' })
    expect(chain.getLogsCalls[0]).toMatchObject({ fromBlock: 0, toBlock: 50 })
  })

  it('throws not_executed for a successful transaction that carries no event for the op', async () => {
    const chain = fakeChain({ wait: receipt(TX, 1, [opEvent(OTHER_OP, true)]) })
    await expect(confirmUserOperation({ ...base, provider: chain })).rejects.toMatchObject({ reason: 'not_executed' })
  })
})

describe('findUserOperation', () => {
  it('looks again until the op is mined, then returns its receipt', async () => {
    const { findUserOperation, ENTRY_POINT_EVENTS_ABI } = await import('../src/index.js')
    const { Interface } = await import('ethers')
    const events = new Interface(ENTRY_POINT_EVENTS_ABI as unknown as string[])
    const ep = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
    const hash = '0x' + 'ab'.repeat(32)
    let looks = 0
    const ev = events.encodeEventLog('UserOperationEvent', [hash, '0x' + '11'.repeat(20), '0x' + '00'.repeat(20), 1n, true, 1n, 1n])
    const receipt = await findUserOperation({
      provider: {
        getBlockNumber: async () => 100,
        getLogs: async () => (++looks < 3 ? [] : ([{ transactionHash: '0xtx', removed: false }] as never)),
        getTransactionReceipt: async () => ({ hash: '0xtx', logs: [{ address: ep, ...ev }] }) as never,
      },
      entryPoint: ep,
      userOpHash: hash,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    })
    expect(receipt.hash).toBe('0xtx')
    expect(looks).toBe(3)
  })
})
