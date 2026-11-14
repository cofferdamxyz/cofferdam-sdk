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
    // The L1 part repays at least 1.25 × the L1 fee at the op's price.
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

  // cofferdam-api `services/testRelay.ts` (branch claude/zkp-plane-53039e at
  // 8c67738), `requiredPreVerificationGas`: ceil(getL1Fee × 125%) / price,
  // ceiled, plus the handleOps calldata gas plus 21,000 (the SDK's
  // calldataGas already includes the 21,000).
  function planeRequired(l1Fee: bigint, price: bigint, handleOpsData: string): bigint {
    const l1 = (l1Fee * 125n + 99n) / 100n
    return (l1 + price - 1n) / price + calldataGas(handleOpsData)
  }

  it("clears the plane's floor for the op as really signed, with an oracle priced by size", async () => {
    const HANDLE_OPS = new Interface([
      'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary)',
    ])
    // A bind-sized op: 12 KB of call data, mostly incompressible.
    const bindOp = { ...op, callData: standInSignature(9, 12_000) }
    const perByte = 100_000n // wei per byte of the unsigned transaction
    const runner = {
      async call(tx: { to: string; data: string }) {
        const unsigned = ORACLE.decodeFunctionData('getL1Fee', tx.data)[0] as string
        return AbiCoder.defaultAbiCoder().encode(['uint256'], [BigInt(getBytes(unsigned).length) * perByte])
      },
    }
    const price = 10_000_000n
    const pvg = await estimateL1PreVerificationGas({
      runner,
      chainId: 8453,
      entryPoint: EP,
      userOp: { ...bindOp, preVerificationGas: (1n << 32n) - 1n, signature: standInSignature(0) },
      maxFeePerGas: price,
    })
    // The real op: the estimate signed in, a 480-byte WebAuthn inner signature, the relayer as beneficiary.
    const real = { ...bindOp, preVerificationGas: pvg, signature: standInSignature(0, 480) }
    const data = HANDLE_OPS.encodeFunctionData('handleOps', [
      [[real.sender, real.nonce, real.initCode, real.callData, real.accountGasLimits, real.preVerificationGas, real.gasFees, real.paymasterAndData, real.signature]],
      '0x' + '7e'.repeat(20),
    ])
    const relayerTx = Transaction.from({ type: 2, chainId: 8453n, nonce: 0, to: EP, data, gasLimit: 5_000_000n, maxFeePerGas: price, maxPriorityFeePerGas: price })
    const l1Fee = BigInt(getBytes(relayerTx.unsignedSerialized).length) * perByte
    expect(pvg).toBeGreaterThanOrEqual(planeRequired(l1Fee, price, data))
    // ...and with the L1 fee 10% higher by the time the plane checks.
    expect(pvg).toBeGreaterThanOrEqual(planeRequired((l1Fee * 110n) / 100n, price, data))
  })
})
