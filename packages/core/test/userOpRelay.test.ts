// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { Interface } from 'ethers'
import {
  USER_OPERATION_PATH,
  UserOpRelayError,
  buildInitCode,
  relayUserOperation,
  serializeUserOperation,
  type PackedUserOperation,
} from '../src/index.js'

const FACTORY = '0x35CeBf87f5DAE7be7cf755067d30fC65Fa541F3D'
const MODULE = '0x279Cf7DF840a76EE9EcC1C177698E6EaB490Eea8'
const FACTORY_IFACE = new Interface([
  'function deployAccount(address initialModule, bytes initialConfig, bytes32 salt) returns (address)',
])

const op: PackedUserOperation = {
  sender: '0x80967a159A00dcabe2DeAF86b68249acfc45C265',
  nonce: 0n,
  initCode: '0x',
  callData: '0x1234',
  accountGasLimits: '0x' + '00'.repeat(32),
  preVerificationGas: 21_000n,
  gasFees: '0x' + '00'.repeat(32),
  paymasterAndData: '0x',
  signature: '0xabcd',
}

describe('buildInitCode', () => {
  it('is the factory address followed by the deployAccount calldata', () => {
    const config = '0x' + '11'.repeat(64)
    const salt = '0x' + '22'.repeat(32)
    const initCode = buildInitCode(FACTORY, FACTORY_IFACE, MODULE, config, salt)
    expect(initCode.slice(0, 42).toLowerCase()).toBe(FACTORY.toLowerCase())
    const calldata = '0x' + initCode.slice(42)
    expect(calldata.slice(0, 10)).toBe(FACTORY_IFACE.getFunction('deployAccount')!.selector)
    const decoded = FACTORY_IFACE.decodeFunctionData('deployAccount', calldata)
    expect(decoded[0].toLowerCase()).toBe(MODULE.toLowerCase())
    expect(decoded[1]).toBe(config)
    expect(decoded[2]).toBe(salt)
  })
})

describe('serializeUserOperation', () => {
  it('writes bigints as decimal strings and keeps bytes as hex', () => {
    const json = serializeUserOperation({ ...op, nonce: 7n, preVerificationGas: 123_456n })
    expect(json.nonce).toBe('7')
    expect(json.preVerificationGas).toBe('123456')
    expect(json.callData).toBe('0x1234')
    expect(JSON.stringify(json)).not.toContain('n"')
  })
})

describe('relayUserOperation', () => {
  it('posts the serialized op to the plane and returns the tx hash', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ok: true, txHash: '0xdead' }), { status: 202 })
    }
    const res = await relayUserOperation({ relayerUrl: 'https://plane.test/', userOp: op, entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', fetchImpl })
    expect(res.txHash).toBe('0xdead')
    expect(calls[0].url).toBe('https://plane.test' + USER_OPERATION_PATH)
    expect((calls[0].body as { userOp: { nonce: string } }).userOp.nonce).toBe('0')
  })

  it("throws the plane's error id when the relay refuses", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: 'paymaster_not_ours', message: 'nope' }), { status: 400 })
    await expect(
      relayUserOperation({ relayerUrl: 'https://plane.test', userOp: op, entryPoint: '0x0', fetchImpl }),
    ).rejects.toMatchObject({ name: 'UserOpRelayError', code: 'paymaster_not_ours', status: 400 })
    expect(new UserOpRelayError('x', 'y', 500).message).toContain('x')
  })
})
