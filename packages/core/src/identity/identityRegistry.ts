// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `CofferdamIdentityRegistry` (workspace decision 0080): the provider-agnostic
 * registry that binds one person's identifier to one Cofferdam account, and
 * its first evidence adapter, `ZKPassportEvidenceAdapter`.
 *
 * The flow a client runs for a bind:
 *   1. `client.customData('bind', account)`: the registry's digest for the
 *      account's next action, as the 66-character lowercase hex string the
 *      ZKPassport request must bind as `custom_data` (with `user_address` =
 *      the account and chain `base`).
 *   2. The proof comes back; `zkpEvidenceFromParams(params)` turns ZKPassport's
 *      `getSolidityVerifierParameters` result into the adapter's `evidence`.
 *   3. `client.check('bind', account, adapter, evidence)` by `eth_call`: the
 *      same checks the transaction runs, or the same revert.
 *   4. The account sends `{ to: registry, data: encodeBindCall(adapter, evidence) }`
 *      as its own user operation (`NativeAccountProvider.sendTransaction`,
 *      which throws unless the operation itself succeeded).
 *   5. `client.isAccountBound(account)` says "verified".
 *
 * A re-bind (decision 0022) moves a bound identifier to a new, unbound
 * account: the new account proves against `customData('rebind', account)`,
 * checks with `check('rebind', …)` and sends `encodeRequestRebindCall`. After
 * the registry's `REBIND_DELAY` anyone sends `encodeFinalizeRebindCall(identifier)`,
 * the identifier read from the request's own `RebindRequested` event
 * (`rebindRequestedFromLogs`), never stored; the bound account may veto it
 * meanwhile with `encodeCancelRebindCall`.
 *
 * The encodings must equal base-contracts' `scripts/lib/identity.ts` byte for
 * byte; `test/fixtures/identity-digest.json` (copied from base-contracts)
 * pins the digest and `custom_data`.
 *
 * The identifier the registry returns and the registry's errors' arguments
 * name the passport: never log, store or send them. Errors here carry only
 * the error's name.
 */

import { AbiCoder, Contract as EthContract, Interface, keccak256, toUtf8Bytes, type ContractRunner } from 'ethers'

const abi = AbiCoder.defaultAbiCoder()

/** The action tags; the registry folds `keccak256(tag)` into the digest. */
export const IDENTITY_ACTION_TAGS = {
  bind: 'cofferdam-identity-bind-v1',
  rebind: 'cofferdam-identity-rebind-v1',
  relink: 'cofferdam-identity-relink-v1',
} as const

export type IdentityAction = keyof typeof IDENTITY_ACTION_TAGS

/** `BIND`, `REBIND`, `RELINK` as the registry holds them: `keccak256(tag)`. */
export const IDENTITY_ACTIONS: Readonly<Record<IdentityAction, string>> = {
  bind: keccak256(toUtf8Bytes(IDENTITY_ACTION_TAGS.bind)),
  rebind: keccak256(toUtf8Bytes(IDENTITY_ACTION_TAGS.rebind)),
  relink: keccak256(toUtf8Bytes(IDENTITY_ACTION_TAGS.relink)),
}

/**
 * `CofferdamIdentityRegistry.digest(action, account)` computed off-chain:
 * `keccak256(abi.encode(keccak256(tag), chainId, registry, account, nonce))`,
 * where `nonce` is `registry.nonces(account)`. Prefer reading it from the
 * registry (`CofferdamIdentityRegistryClient.digest`); this is for tests and
 * for checking a digest you were handed.
 */
export function identityDigest(
  action: IdentityAction,
  chainId: bigint | number,
  registry: string,
  account: string,
  nonce: bigint | number,
): string {
  return keccak256(
    abi.encode(
      ['bytes32', 'uint256', 'address', 'address', 'uint256'],
      [IDENTITY_ACTIONS[action], BigInt(chainId), registry, account, BigInt(nonce)],
    ),
  )
}

/**
 * The ZKPassport `custom_data` a proof must be bound to: the digest as
 * lowercase `0x` hex, 66 characters. The adapter compares strings, so any other
 * spelling (upper case, no `0x`) fails with `WrongBoundDigest`.
 */
export function zkpCustomData(digest: string): string {
  const hex = digest.toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new Error(`[cofferdam-sdk] not a 32-byte digest: ${digest}`)
  return hex
}

/** A compressed-EVM proof as ZKPassport's SDK `getSolidityVerifierParameters` returns it (0.19.x). */
export interface ZkpSolidityParams {
  version: string
  proofVerificationData: { vkeyHash: string; proof: string; publicInputs: string[] }
  committedInputs: string
  serviceConfig: { validityPeriodInSeconds: number; domain: string; scope: string; devMode: boolean }
}

/** The proof fields the adapter takes. */
export interface ZkpEvidence {
  vkeyHash: string
  proof: string | Uint8Array
  publicInputs: string[]
  committedInputs: string | Uint8Array
}

/**
 * `ZKPassportEvidenceAdapter` evidence:
 * `abi.encode(bytes32 vkeyHash, bytes proof, bytes32[] publicInputs, bytes committedInputs)`.
 */
export function encodeZkpEvidence(p: ZkpEvidence): string {
  return abi.encode(['bytes32', 'bytes', 'bytes32[]', 'bytes'], [p.vkeyHash, p.proof, p.publicInputs, p.committedInputs])
}

/**
 * The adapter's evidence from ZKPassport's verifier parameters: only the
 * proof's own fields. `version` and `serviceConfig` are not sent; the adapter
 * pins its circuits version, domain, scope and validity.
 */
export function zkpEvidenceFromParams(params: ZkpSolidityParams): string {
  return encodeZkpEvidence({ ...params.proofVerificationData, committedInputs: params.committedInputs })
}

/** The registry's surface this SDK uses, with the registry's and the adapter's errors so reverts decode by name. */
export const COFFERDAM_IDENTITY_REGISTRY_ABI = [
  'function bind(address adapter, bytes evidence)',
  'function requestRebind(address adapter, bytes evidence)',
  'function finalizeRebind(bytes32 identifier)',
  'function cancelRebind(bytes32 identifier)',
  'function pendingRebind(bytes32 identifier) view returns (address oldAccount, address newAccount, uint48 readyAt, address adapter)',
  'event RebindRequested(address indexed oldAccount, address indexed newAccount, bytes32 indexed identifier, uint256 nonce, uint48 readyAt)',
  'function digest(bytes32 action, address account) view returns (bytes32)',
  'function nonces(address account) view returns (uint256)',
  'function isAccountBound(address account) view returns (bool)',
  'function check(bytes32 action, address account, address adapter, bytes evidence) view returns (bytes32 identifier, address counterpart)',
  // CofferdamIdentityRegistry
  'error NotOwner()',
  'error NotPendingOwner()',
  'error ZeroAddress()',
  'error ZeroValue()',
  'error DelayTooShort(uint256 delay, uint256 minimum)',
  'error DelayTooLong(uint256 delay, uint256 maximum)',
  'error Paused()',
  'error NotTestAccount(address account)',
  'error UnknownAction(bytes32 action)',
  'error AdapterNotActive(address adapter)',
  'error AdapterAlreadyActive(address adapter)',
  'error AdapterNotProposed(address adapter)',
  'error AdapterNotReady(uint256 readyAt)',
  'error AdapterProposalExpired(uint256 expiredAt)',
  'error WrongIdentifierKind(bytes32 expected, bytes32 got)',
  'error WrongScope(bytes32 expected, bytes32 got)',
  'error ZeroIdentifier()',
  'error RetiredIdentifier(bytes32 identifier)',
  'error AccountAlreadyBound(address account, bytes32 identifier)',
  'error IdentifierAlreadyBound(bytes32 identifier, address account)',
  'error AccountNotBound(address account)',
  'error IdentifierNotBound(bytes32 identifier)',
  'error SameIdentifier(bytes32 identifier)',
  'error SameAccount(address account)',
  'error NoPendingRebind(bytes32 identifier)',
  'error RebindNotReady(uint48 readyAt)',
  'error RebindStale(bytes32 identifier)',
  'error NotBoundAccount(address caller, address bound)',
  // Relink and claims on a retired identifier (decision 0080 P4, base-contracts main since 2026-11-19)
  'error RebindPending(bytes32 identifier)',
  'error RetiredNeedsRuling(bytes32 identifier)',
  'error NotRetired(bytes32 identifier)',
  // ZKPassportEvidenceAdapter (constructor errors omitted: they never reach a call)
  'error MalformedEvidence()',
  'error WrongIdentifierType(uint256 expected, uint256 got)',
  'error WrongOprfKey(bytes32 expected, bytes32 got)',
  'error ProofInvalid()',
  'error IdentifierMismatch(bytes32 verified, bytes32 publicInput)',
  'error HelperMismatch(address expected, address got)',
  'error WrongBoundAccount(address expected, address got)',
  'error WrongBoundChain(uint256 expected, uint256 got)',
  'error WrongBoundDigest()',
  'error AgeNotProven(uint8 minAge)',
  'error ExpiryNotProven(uint256 earliest)',
  'error DisclosureRefused(uint8 sectionType)',
  'error VerificationMethodRefused(uint256 method)',
  'error MalformedCommittedInputs()',
  'error BindSectionCount(uint256 count)',
] as const

const REGISTRY_IFACE = new Interface(COFFERDAM_IDENTITY_REGISTRY_ABI as unknown as string[])

/** Calldata for `registry.bind(adapter, evidence)`, sent by the account itself (the registry binds `msg.sender`). */
export function encodeBindCall(adapter: string, evidence: string): string {
  return REGISTRY_IFACE.encodeFunctionData('bind', [adapter, evidence])
}

/**
 * Calldata for `registry.requestRebind(adapter, evidence)`, sent by the new,
 * unbound account with a proof bound to `customData('rebind', account)`.
 */
export function encodeRequestRebindCall(adapter: string, evidence: string): string {
  return REGISTRY_IFACE.encodeFunctionData('requestRebind', [adapter, evidence])
}

/** Calldata for `registry.finalizeRebind(identifier)`, once the pending rebind's `readyAt` has passed (anyone may send it). */
export function encodeFinalizeRebindCall(identifier: string): string {
  return REGISTRY_IFACE.encodeFunctionData('finalizeRebind', [identifier])
}

/** Calldata for `registry.cancelRebind(identifier)`, sent by the account the identifier is bound to now. */
export function encodeCancelRebindCall(identifier: string): string {
  return REGISTRY_IFACE.encodeFunctionData('cancelRebind', [identifier])
}

/** A `RebindRequested` event: `identifier` names the passport, so keep it in memory only. */
export interface RebindRequest {
  oldAccount: string
  newAccount: string
  identifier: string
  /** Unix seconds from which `finalizeRebind` applies it. */
  readyAt: number
}

/**
 * The rebind request `newAccount` made, from a receipt's logs (the
 * `requestRebind` op's transaction); null when the logs hold none. Logs of
 * other contracts and other accounts are skipped.
 */
export function rebindRequestedFromLogs(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  registry: string,
  newAccount: string,
): RebindRequest | null {
  const reg = registry.toLowerCase()
  const want = newAccount.toLowerCase()
  for (const log of logs) {
    if (log.address.toLowerCase() !== reg) continue
    let parsed
    try {
      parsed = REGISTRY_IFACE.parseLog({ topics: [...log.topics], data: log.data })
    } catch {
      continue
    }
    if (parsed?.name !== 'RebindRequested') continue
    const to = (parsed.args.getValue('newAccount') as string).toLowerCase()
    if (to !== want) continue
    return {
      oldAccount: parsed.args.getValue('oldAccount') as string,
      newAccount: parsed.args.getValue('newAccount') as string,
      identifier: parsed.args.getValue('identifier') as string,
      readyAt: Number(parsed.args.getValue('readyAt') as bigint),
    }
  }
  return null
}

const ERROR_STRING = '0x08c379a0'
const PANIC = '0x4e487b71'

/**
 * A revert's name, never its arguments (they carry the passport's identifier):
 * a registry or adapter error's name, `Error` or `Panic` for Solidity's own,
 * the 4-byte selector for an unknown error, `empty` for no data.
 */
export function identityRevertName(data: string | null | undefined): string {
  if (!data || data === '0x') return 'empty'
  if (!/^0x[0-9a-fA-F]{8}/.test(data)) return 'malformed'
  const selector = data.slice(0, 10).toLowerCase()
  if (selector === ERROR_STRING) return 'Error'
  if (selector === PANIC) return 'Panic'
  return REGISTRY_IFACE.getError(selector)?.name ?? selector
}

/** The registry refused: `errorName` is the registry's or the adapter's error (see `identityRevertName`). */
export class IdentityRegistryError extends Error {
  constructor(readonly errorName: string) {
    super(`[cofferdam-sdk] identity registry reverted: ${errorName}`)
    this.name = 'IdentityRegistryError'
  }
}

export interface CofferdamIdentityRegistryClientConfig {
  /** The registry's address, from the caller's configuration (no address table). */
  address: string
  /** A read-only runner, e.g. an ethers `JsonRpcProvider` on the registry's chain. */
  runner: ContractRunner
}

/** What `check` proves: the identifier, and the account it is bound to now (REBIND) or the account itself (RELINK). */
export interface IdentityCheckResult {
  /** Names the passport: never log, store or send it. */
  identifier: string
  /** Zero address for BIND. */
  counterpart: string
}

/** A pending rebind as the registry holds it; `newAccount` is the zero address when none is pending. */
export interface PendingRebind {
  oldAccount: string
  newAccount: string
  /** Unix seconds. */
  readyAt: number
  adapter: string
}

/** Read-only client for `CofferdamIdentityRegistry`. Writes go through the account (`encodeBindCall`, `encodeRequestRebindCall`, `encodeFinalizeRebindCall`). */
export class CofferdamIdentityRegistryClient {
  readonly address: string
  private readonly contract: EthContract

  constructor(config: CofferdamIdentityRegistryClientConfig) {
    this.address = config.address
    this.contract = new EthContract(config.address, REGISTRY_IFACE, config.runner)
  }

  /** The digest the account's next proof for `action` must be bound to (consumed by the action). */
  async digest(action: IdentityAction, account: string): Promise<string> {
    return (await this.contract.getFunction('digest')(IDENTITY_ACTIONS[action], account)) as string
  }

  /** `digest` as the ZKPassport request's `custom_data` (lowercase hex, 66 characters). */
  async customData(action: IdentityAction, account: string): Promise<string> {
    return zkpCustomData(await this.digest(action, account))
  }

  /** The nonce the account's next proof is bound to; each bind, relink or rebind request consumes one. */
  async nonces(account: string): Promise<bigint> {
    return (await this.contract.getFunction('nonces')(account)) as bigint
  }

  /** The rebind of `identifier` waiting for `REBIND_DELAY`; `newAccount` is the zero address when none is pending. */
  async pendingRebind(identifier: string): Promise<PendingRebind> {
    const [oldAccount, newAccount, readyAt, adapter] = (await this.contract.getFunction('pendingRebind')(identifier)) as [
      string,
      string,
      bigint,
      string,
    ]
    return { oldAccount, newAccount, readyAt: Number(readyAt), adapter }
  }

  /** Whether an identifier is bound to `account`. */
  async isAccountBound(account: string): Promise<boolean> {
    return Boolean(await this.contract.getFunction('isAccountBound')(account))
  }

  /**
   * Pre-flight by `eth_call`: every check `bind`, `relink` or `requestRebind`
   * would run for `account` (the account that will send it). Throws
   * `IdentityRegistryError` with the error's name when the transaction would
   * revert, and a plain `Error` naming only the failure's code when the call
   * could not run (a node error, a rate limit). Neither carries the request:
   * ethers' own error holds the evidence, whose public inputs name the passport.
   */
  async check(action: IdentityAction, account: string, adapter: string, evidence: string): Promise<IdentityCheckResult> {
    try {
      const [identifier, counterpart] = (await this.contract.getFunction('check').staticCall(
        IDENTITY_ACTIONS[action],
        account,
        adapter,
        evidence,
      )) as [string, string]
      return { identifier, counterpart }
    } catch (err) {
      const data = revertData(err)
      if (data !== null) throw new IdentityRegistryError(identityRevertName(data))
      const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'error'
      // No `cause` on purpose: ethers' error holds the request, whose evidence names the passport.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`[cofferdam-sdk] identity registry check could not run (${code})`)
    }
  }
}

/**
 * The revert data of an ethers `CALL_EXCEPTION`, or null when the error is not
 * a revert. ethers also reports a JSON-RPC error on `eth_call` (a missing
 * header, a rate limit) as `CALL_EXCEPTION`, with `data` null: that is not a
 * revert. A revert without data has `data` `0x`.
 */
function revertData(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { code?: unknown; data?: unknown }
  if (e.code !== 'CALL_EXCEPTION') return null
  return typeof e.data === 'string' ? e.data : null
}
