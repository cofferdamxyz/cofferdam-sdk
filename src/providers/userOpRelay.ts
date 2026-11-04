// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * UserOperation relay — the production path for submitting a signed ERC-4337
 * `PackedUserOperation`. The client never holds a funded key: it POSTs the
 * signed op to the plane (`cofferdam-api`, `POST /v1/aa/user-operation`),
 * whose relayer calls `EntryPoint.handleOps` with its own key and is refunded
 * from the paymaster's deposit. A not-yet-deployed account rides along: the
 * op's `initCode` (factory ++ `deployAccount` calldata) makes the EntryPoint
 * create it in the same bundle, so the first sponsored op is the deployment.
 *
 * The helpers are pure and unit-tested; the HTTP call takes an injectable
 * `fetch` so callers (and tests) can supply their own.
 */
import { concat, type Interface } from 'ethers'
import type { Permission } from './permission.js'

/** EntryPoint v0.7 packed operation, as the SDK builds and signs it. */
export interface PackedUserOperation {
  sender: string
  nonce: bigint
  initCode: string
  callData: string
  accountGasLimits: string
  preVerificationGas: bigint
  gasFees: string
  paymasterAndData: string
  signature: string
}

/** Wire shape: bigints as decimal strings, bytes as `0x` hex. */
export interface PackedUserOperationJson {
  sender: string
  nonce: string
  initCode: string
  callData: string
  accountGasLimits: string
  preVerificationGas: string
  gasFees: string
  paymasterAndData: string
  signature: string
}

/** Route on the plane that relays a signed op. */
export const USER_OPERATION_PATH = '/v1/aa/user-operation'

export function serializeUserOperation(op: PackedUserOperation): PackedUserOperationJson {
  return {
    sender: op.sender,
    nonce: op.nonce.toString(),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: op.preVerificationGas.toString(),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  }
}

/**
 * `initCode` for EntryPoint v0.7: the factory address followed by the
 * `deployAccount(initialModule, initialConfig, salt)` calldata. The EntryPoint
 * calls the factory through its SenderCreator and requires the returned
 * address to equal `sender` (AA14 otherwise).
 */
export function buildInitCode(
  factory: string,
  factoryIface: Interface,
  initialModule: string,
  initialConfig: string,
  initialPermission: Permission,
  salt: string,
): string {
  return concat([
    factory,
    factoryIface.encodeFunctionData('deployAccount', [initialModule, initialConfig, initialPermission, salt]),
  ])
}

/** The plane refused or failed to relay the op. `code` is its error id. */
export class UserOpRelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(`[cofferdam-sdk] relay ${code}: ${message}`)
    this.name = 'UserOpRelayError'
  }
}

export interface RelayUserOperationOptions {
  /** Plane base URL, e.g. `https://cofferdam-api.example.workers.dev`. */
  relayerUrl: string
  userOp: PackedUserOperation
  /** EntryPoint the op was hashed against; the plane refuses any other. */
  entryPoint: string
  fetchImpl?: typeof fetch | undefined
}

/** POST the signed op to the plane; resolves with the `handleOps` tx hash. */
export async function relayUserOperation(opts: RelayUserOperationOptions): Promise<{ txHash: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = opts.relayerUrl.replace(/\/+$/, '') + USER_OPERATION_PATH
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entryPoint: opts.entryPoint, userOp: serializeUserOperation(opts.userOp) }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    txHash?: string
    error?: string
    message?: string
  }
  if (!res.ok || !body.ok || !body.txHash) {
    throw new UserOpRelayError(body.error ?? `http_${res.status}`, body.message ?? `relayer answered ${res.status}`, res.status)
  }
  return { txHash: body.txHash }
}
