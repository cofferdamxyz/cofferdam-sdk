// OffshoreSyncEscrowClient — Phase α-2 / α-3.
//
// Typed, framework-agnostic client for the v1/zksync OffshoreSyncEscrow
// contract. Wraps a `zksync-ethers` Contract instance with:
//
//   - Both posting paths:
//       • self-funded   — `postContract(termsHash, amountWei)`
//       • corporate     — `postContractIntent(...)` + `fundContract(...)`
//   - Full lifecycle  — `awardContract`, `checkIn`, `checkOut`, `settle`,
//                        `cancel`, `cancelDraft`
//   - State reads     — `getContract(contractId)` returns a typed snapshot
//                        with `status` as a string union (not the raw uint8)
//   - Static helpers  — `OffshoreSyncEscrowClient.hashTerms(...)` canonical
//                        keccak256 of a string or JSON-serialisable object
//
// Why this exists
// ───────────────
// In α-2 every consumer app re-implemented its own ABI fragment + viem/ethers
// glue to talk to the escrow (see capacitor-minimal's `ESCROW_ABI` block).
// That's fine for one demo but doesn't scale: the corporate-flow event order
// (`ContractDrafted` → `ContractFunded` → `ContractPosted`), the
// "designatedFunder == address(0) means open funding" rule, and the "settle
// is value-less because escrow pays internally" detail all need to live in
// one place that consumers can `import` from.
//
// What this client is NOT
// ───────────────────────
// - Not a passkey / smart-account signer. It expects a `zksync-ethers` Wallet
//   (or anything signature-compatible). The α-2 demo passes a deterministic
//   EOA derived from `mockUserId`; β replaces that with a passkey-backed AA
//   account contract — the client API doesn't change.
// - Not aware of identity binding. The contract enforces
//   `identity.isAccountBound(msg.sender)` itself; this client just surfaces
//   the resulting revert as a typed error. Sign-in via `LocalChainProvider`
//   handles binding upstream.
// - Not a dispute / arbiter surface. Disputes are owner-only (the LLC
//   Treasury Safe in production) and out of scope for the consumer-facing
//   client. A separate `OffshoreSyncEscrowArbiterClient` may land later.

import { keccak256, toUtf8Bytes, type Interface, type Log } from 'ethers'
import { Contract as ZkContract, Wallet as ZkWallet, Provider as ZkProvider } from 'zksync-ethers'

// ────────────────────────────────────────────────────────────────────────────
// Public ABI fragment
// ────────────────────────────────────────────────────────────────────────────
//
// Kept inline rather than imported from the Hardhat artifact JSON so this
// package doesn't drag a compiled-contract dependency. The fragment is the
// minimal surface needed for both flows + every lifecycle transition.

export const OFFSHORESYNC_ESCROW_ABI = [
  // ── self-funded path ─────────────────────────────────────────────────
  'function postContract(bytes32 termsHash) payable returns (uint256)',
  // ── corporate path ───────────────────────────────────────────────────
  'function postContractIntent(bytes32 termsHash, uint256 amount, address designatedFunder) returns (uint256)',
  'function fundContract(uint256 contractId) payable',
  'function cancelDraft(uint256 contractId)',
  // ── shared lifecycle ─────────────────────────────────────────────────
  'function awardContract(uint256 contractId, address workerAccount)',
  'function checkIn(uint256 contractId)',
  'function checkOut(uint256 contractId)',
  'function settle(uint256 contractId)',
  'function cancel(uint256 contractId)',
  // ── reads ────────────────────────────────────────────────────────────
  'function getContract(uint256 contractId) view returns (tuple(address recruiter, address designatedFunder, address funder, address worker, uint256 amount, bytes32 termsHash, uint64 draftedAt, uint64 postedAt, uint64 awardedAt, uint64 checkedInAt, uint64 checkedOutAt, uint8 status))',
  'function nextContractId() view returns (uint256)',
  // ── events (decoded by extractContractId + tx receipt helpers) ───────
  'event ContractDrafted(uint256 indexed contractId, address indexed recruiter, address indexed designatedFunder, uint256 amount, bytes32 termsHash)',
  'event ContractFunded(uint256 indexed contractId, address indexed funder, uint256 amount)',
  'event ContractPosted(uint256 indexed contractId, address indexed recruiter, uint256 amount, bytes32 termsHash)',
  'event ContractAwarded(uint256 indexed contractId, address indexed recruiter, address indexed worker)',
  'event WorkerCheckedIn(uint256 indexed contractId, address indexed worker, uint64 at)',
  'event WorkerCheckedOut(uint256 indexed contractId, address indexed worker, uint64 at)',
  'event ContractSettled(uint256 indexed contractId, address indexed worker, uint256 amount)',
  'event DraftCancelled(uint256 indexed contractId, address indexed recruiter)',
  'event ContractCancelled(uint256 indexed contractId, address indexed recruiter, uint256 refund)',
] as const

// ────────────────────────────────────────────────────────────────────────────
// Status enum mirror
// ────────────────────────────────────────────────────────────────────────────
//
// Mirrors the Solidity Status enum byte-for-byte. `Drafted` is appended at
// index 8 because it was added after the original 0..7 lifecycle shipped —
// see OffshoreSyncEscrow.sol §"Job-contract state machine".

export type JobContractStatus =
  | 'Posted' // 0 — funded, awaiting award
  | 'Awarded' // 1 — worker assigned
  | 'CheckedIn' // 2 — worker on-site
  | 'CheckedOut' // 3 — worker finished, awaiting settle
  | 'Settled' // 4 — funds paid to worker (terminal)
  | 'Cancelled' // 5 — terminal
  | 'Disputed' // 6 — awaiting arbiter
  | 'Resolved' // 7 — terminal (post-dispute)
  | 'Drafted' // 8 — corporate flow: intent posted, not yet funded

const STATUS_BY_INDEX: readonly JobContractStatus[] = [
  'Posted',
  'Awarded',
  'CheckedIn',
  'CheckedOut',
  'Settled',
  'Cancelled',
  'Disputed',
  'Resolved',
  'Drafted',
]

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface OffshoreSyncEscrowClientConfig {
  /** Deployed `OffshoreSyncEscrow` address. */
  address: string

  /**
   * Wallet that will sign + send state-mutating txs. Must be a
   * Cofferdam-bound EOA / smart account (the contract enforces this via
   * `onlyBoundAccount`).
   */
  signer: ZkWallet

  /**
   * Optional read-only provider used for `getContract()` and other view
   * calls. Defaults to `signer.provider`, which is what you want 99% of
   * the time. Override if you want reads to go through a faster RPC than
   * the signer's network.
   */
  provider?: ZkProvider
}

/**
 * Open-funding sentinel for `postContractIntent.designatedFunder`. Passing
 * this means "any Cofferdam-bound account can fund this draft" — useful for
 * solo recruiters who don't yet know which company will pick up the tab.
 */
export const OPEN_FUNDING: '0x0000000000000000000000000000000000000000' =
  '0x0000000000000000000000000000000000000000'

export interface PostResult {
  contractId: bigint
  txHash: string
}

export interface TxResult {
  txHash: string
}

/**
 * Optional callbacks + overrides accepted by every mutating method on the
 * client. Pass an `onSent` handler if you need to render a "tx submitted,
 * waiting for confirmation" state in your UI between submit and `wait()`.
 */
export interface TxOptions {
  /**
   * Invoked the moment the tx is broadcast (post-signature, pre-confirmation).
   * Receives the tx hash. Useful for progressive UI updates and tail logs.
   */
  onSent?: (txHash: string) => void
}

export interface JobContractState {
  contractId: bigint
  recruiter: string
  /**
   * `address(0)` (== `OPEN_FUNDING`) means "open funding": any bound account
   * can fund this draft. Otherwise this address is the only one that can.
   */
  designatedFunder: string
  /** `address(0)` until funded. */
  funder: string
  /** `address(0)` until awarded. */
  worker: string
  amount: bigint
  termsHash: string
  /** Unix seconds. 0 if posted via the self-funded path. */
  draftedAt: number
  /** Unix seconds. Set when funded (or at postContract time for self-funded). */
  postedAt: number
  /** Unix seconds. 0 until awarded. */
  awardedAt: number
  /** Unix seconds. 0 until checked in. */
  checkedInAt: number
  /** Unix seconds. 0 until checked out. */
  checkedOutAt: number
  status: JobContractStatus
}

// ────────────────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────────────────

export class OffshoreSyncEscrowClient {
  /** Deployed escrow contract address. */
  readonly address: string

  /** Bound signing wallet (mutating calls go through this). */
  readonly signer: ZkWallet

  /** Read provider. Defaults to `signer.provider`. */
  readonly provider: ZkProvider

  /** Pre-built `zksync-ethers` Contract bound to the signer. */
  private readonly contract: ZkContract

  /** Same address as `contract` but bound to `provider` for view calls. */
  private readonly readonly: ZkContract

  /** Cached `ethers.Interface` for event decoding. */
  private readonly iface: Interface

  constructor(config: OffshoreSyncEscrowClientConfig) {
    this.address = config.address
    this.signer = config.signer
    const signerProvider = (config.signer.provider ?? null) as ZkProvider | null
    if (!config.provider && !signerProvider) {
      throw new Error(
        '[cofferdam-sdk] OffshoreSyncEscrowClient: signer has no provider and no fallback provider was supplied.',
      )
    }
    this.provider = config.provider ?? (signerProvider as ZkProvider)
    this.contract = new ZkContract(this.address, OFFSHORESYNC_ESCROW_ABI as unknown as string[], config.signer)
    this.readonly = new ZkContract(this.address, OFFSHORESYNC_ESCROW_ABI as unknown as string[], this.provider)
    this.iface = this.contract.interface
  }

  // ──────────────────────────────────────────────────────────────────────
  // Self-funded path
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Self-funded post: recruiter both posts the job and locks the amount
   * in a single tx. Caller (signer) must be a Cofferdam-bound recruiter.
   *
   * @param termsHash  keccak256 of the canonical off-chain terms blob.
   *                   Build via `OffshoreSyncEscrowClient.hashTerms(...)`.
   * @param amountWei  Native ETH amount to lock (in wei).
   * @returns `{ contractId, txHash }` once the tx mines.
   */
  async postContract(
    termsHash: string,
    amountWei: bigint,
    opts: TxOptions = {},
  ): Promise<PostResult> {
    const sent = await this.contract.postContract(termsHash, { value: amountWei })
    opts.onSent?.(sent.hash)
    const receipt = await sent.wait()
    const contractId = this.#extractContractId(receipt.logs, 'ContractPosted')
    if (contractId == null) {
      throw new Error(
        '[cofferdam-sdk] postContract: ContractPosted event not found in receipt logs',
      )
    }
    return { contractId, txHash: sent.hash }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Corporate path
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Corporate-flow draft: recruiter (HR) posts an intent without locking
   * funds. A Finance / Treasury account must follow up with `fundContract`
   * to actually lock the money.
   *
   * @param termsHash         keccak256 of canonical terms.
   * @param amountWei         Native ETH to be locked at funding time.
   * @param designatedFunder  Address that's allowed to fund. Pass
   *                          `OPEN_FUNDING` (= `address(0)`) to let any
   *                          Cofferdam-bound account fund.
   */
  async postContractIntent(
    termsHash: string,
    amountWei: bigint,
    designatedFunder: string,
    opts: TxOptions = {},
  ): Promise<PostResult> {
    const sent = await this.contract.postContractIntent(termsHash, amountWei, designatedFunder)
    opts.onSent?.(sent.hash)
    const receipt = await sent.wait()
    const contractId = this.#extractContractId(receipt.logs, 'ContractDrafted')
    if (contractId == null) {
      throw new Error(
        '[cofferdam-sdk] postContractIntent: ContractDrafted event not found in receipt logs',
      )
    }
    return { contractId, txHash: sent.hash }
  }

  /**
   * Fund a drafted contract. Caller must be the `designatedFunder` (or
   * anyone, for an open-funding draft). The value sent must match the
   * draft's committed `amount` exactly — over/under reverts on-chain.
   */
  async fundContract(
    contractId: bigint,
    amountWei: bigint,
    opts: TxOptions = {},
  ): Promise<TxResult> {
    const sent = await this.contract.fundContract(contractId, { value: amountWei })
    opts.onSent?.(sent.hash)
    await sent.wait()
    return { txHash: sent.hash }
  }

  /** Recruiter cancels their own draft before any funder has paid. */
  async cancelDraft(contractId: bigint, opts: TxOptions = {}): Promise<TxResult> {
    const sent = await this.contract.cancelDraft(contractId)
    opts.onSent?.(sent.hash)
    await sent.wait()
    return { txHash: sent.hash }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Shared lifecycle
  // ──────────────────────────────────────────────────────────────────────

  /** Recruiter awards a posted contract to a Cofferdam-bound worker. */
  async awardContract(
    contractId: bigint,
    workerAccount: string,
    opts: TxOptions = {},
  ): Promise<TxResult> {
    const sent = await this.contract.awardContract(contractId, workerAccount)
    opts.onSent?.(sent.hash)
    await sent.wait()
    return { txHash: sent.hash }
  }

  /** Worker check-in (proof of arrival). */
  async checkIn(contractId: bigint, opts: TxOptions = {}): Promise<TxResult> {
    const sent = await this.contract.checkIn(contractId)
    opts.onSent?.(sent.hash)
    await sent.wait()
    return { txHash: sent.hash }
  }

  /** Worker check-out (proof of completion). */
  async checkOut(contractId: bigint, opts: TxOptions = {}): Promise<TxResult> {
    const sent = await this.contract.checkOut(contractId)
    opts.onSent?.(sent.hash)
    await sent.wait()
    return { txHash: sent.hash }
  }

  /**
   * Release escrowed funds to the worker. Public-on-purpose: the worker,
   * the recruiter, the funder, a paymaster, or a Cofferdam keeper bot can
   * call this once the contract is in `CheckedOut`. The tx itself carries
   * no value — the escrow pays out from its locked balance.
   */
  async settle(contractId: bigint, opts: TxOptions = {}): Promise<TxResult> {
    const sent = await this.contract.settle(contractId)
    opts.onSent?.(sent.hash)
    await sent.wait()
    return { txHash: sent.hash }
  }

  /**
   * Recruiter cancels a posted-but-not-yet-awarded contract. Refunds the
   * locked amount to whoever actually fronted it (`c.funder`).
   */
  async cancel(contractId: bigint, opts: TxOptions = {}): Promise<TxResult> {
    const sent = await this.contract.cancel(contractId)
    opts.onSent?.(sent.hash)
    await sent.wait()
    return { txHash: sent.hash }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Reads
  // ──────────────────────────────────────────────────────────────────────

  /** Read a single contract's full state. */
  async getContract(contractId: bigint): Promise<JobContractState> {
    const raw = await this.readonly.getContract(contractId)
    const statusIdx = Number(raw.status)
    const status = STATUS_BY_INDEX[statusIdx]
    if (!status) {
      throw new Error(`[cofferdam-sdk] getContract: unknown status index ${statusIdx}`)
    }
    return {
      contractId,
      recruiter: raw.recruiter,
      designatedFunder: raw.designatedFunder,
      funder: raw.funder,
      worker: raw.worker,
      amount: raw.amount as bigint,
      termsHash: raw.termsHash,
      draftedAt: Number(raw.draftedAt),
      postedAt: Number(raw.postedAt),
      awardedAt: Number(raw.awardedAt),
      checkedInAt: Number(raw.checkedInAt),
      checkedOutAt: Number(raw.checkedOutAt),
      status,
    }
  }

  /** Next contract id that will be assigned. Useful for indexers. */
  async nextContractId(): Promise<bigint> {
    return (await this.readonly.nextContractId()) as bigint
  }

  // ──────────────────────────────────────────────────────────────────────
  // Static helpers
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Canonical keccak256 of an off-chain terms blob. Accepts:
   *   - a string  → hashed verbatim as UTF-8 bytes
   *   - an object → `JSON.stringify` first, then hashed
   *
   * In production, prefer producing the canonical JSON yourself (sorted
   * keys, stable serialisation) and passing a string — this helper exists
   * for demos and tests where the convenience matters more than strict
   * canonicalisation.
   */
  static hashTerms(terms: string | Record<string, unknown>): string {
    const text = typeof terms === 'string' ? terms : JSON.stringify(terms)
    return keccak256(toUtf8Bytes(text))
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  #extractContractId(
    logs: ReadonlyArray<Log>,
    eventName: 'ContractPosted' | 'ContractDrafted',
  ): bigint | null {
    const ev = this.iface.getEvent(eventName)
    if (!ev) return null
    const topic = ev.topicHash
    const target = this.address.toLowerCase()
    for (const log of logs) {
      if (log.topics[0] !== topic) continue
      if (log.address.toLowerCase() !== target) continue
      const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data })
      if (!parsed) continue
      return parsed.args.contractId as bigint
    }
    return null
  }
}
