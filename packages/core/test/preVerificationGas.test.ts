// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { AbiCoder, Interface, Transaction, getBytes } from 'ethers'
import {
  GAS_PRICE_ORACLE,
  STAND_IN_INNER_SIGNATURE_BYTES,
  calldataGas,
  estimateL1PreVerificationGas,
  preVerificationGasForL1Fee,
  standInSignature,
  type PackedUserOperation,
} from '../src/index.js'

const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
const ORACLE = new Interface(['function getL1Fee(bytes data) view returns (uint256)'])
const op: PackedUserOperation = {
  sender: '0x80967a159A00dcabe2DeAF86b68249acfc45C265',
  nonce: 1n,
  initCode: '0x',
  callData: '0x' + '12'.repeat(100),
  accountGasLimits: '0x' + '00'.repeat(32),
  preVerificationGas: 0n,
  gasFees: '0x' + '00'.repeat(32),
  paymasterAndData: '0x',
  signature: standInSignature(0),
}

describe('preVerificationGas for the L1 fee', () => {
  it('counts calldata gas as 21,000 + 4 per zero byte + 16 per other byte', () => {
    expect(calldataGas('0x')).toBe(21_000n)
    expect(calldataGas('0x0001ff00')).toBe(21_000n + 4n + 16n + 16n + 4n)
  })

  it('covers the L1 fee with the margin, rounding up', () => {
    // 1e12 wei of L1 fee at 1e7 wei per gas, with 137.5%: 137,500 gas.
    expect(preVerificationGasForL1Fee(10n ** 12n, 10n ** 7n, 0n)).toBe(137_500n)
    expect(preVerificationGasForL1Fee(1n, 3n, 100n, 10_000n)).toBe(101n)
    const pvg = preVerificationGasForL1Fee(123_456_789n, 7n, 50_000n)
    // The plane's floor: pvg × maxFee ≥ 1.25 × L1 fee.
    expect((pvg - 50_000n) * 7n * 100n >= 123_456_789n * 125n).toBe(true)
    expect(() => preVerificationGasForL1Fee(1n, 0n, 0n)).toThrow()
  })

  it('stand-in signature carries the authority id and incompressible bytes', () => {
    const sig = getBytes(standInSignature(3))
    expect(sig.length).toBe(32 + STAND_IN_INNER_SIGNATURE_BYTES)
    expect(sig[31]).toBe(3)
    expect(new Set(sig.slice(32)).size).toBeGreaterThan(200)
  })

  it('asks the oracle for the unsigned handleOps transaction and adds its calldata gas', async () => {
    let asked: string | null = null
    const runner = {
      async call(tx: { to: string; data: string }) {
        expect(tx.to).toBe(GAS_PRICE_ORACLE)
        asked = ORACLE.decodeFunctionData('getL1Fee', tx.data)[0] as string
        return AbiCoder.defaultAbiCoder().encode(['uint256'], [10n ** 12n])
      },
    }
    const pvg = await estimateL1PreVerificationGas({ runner, chainId: 8453, entryPoint: EP, userOp: op, maxFeePerGas: 10n ** 7n })
    const sent = Transaction.from(asked!)
    expect(sent.to).toBe(EP)
    expect(sent.chainId).toBe(8453n)
    expect(sent.signature).toBeNull()
    expect(pvg).toBe(137_500n + calldataGas(sent.data))
  })
})
