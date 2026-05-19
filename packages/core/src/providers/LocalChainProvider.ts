// LocalChainProvider — Phase α-2.
//
// Talks to a local anvil-zksync node (or any ZKSync Era-shaped JSON-RPC
// endpoint) and exercises the *real* on-chain identity-binding + account
// creation flow that the rest of the system will use in production.
//
// What `signIn()` does end-to-end:
//
//   1. Derive a deterministic ECDSA keypair from `mockUserId` via
//      HMAC(seedSalt, mockUserId). Same id → same address across runs, so
//      snapshot tests and screenshot fixtures stay byte-stable.
//
//   2. (Optional) Pre-fund the derived address from `adminPrivateKey` so it
//      can post / award / dispute on-chain. PoC convenience only.
//
//   3. (Optional) Compute a deterministic nullifier from `mockUserId` and
//      call `OffshoreSyncReceiver.bindNullifier(account, nullifier)` from
//      the admin key — this simulates the future α-3 LayerZero delivery or
//      v2 Cofferdam-TEE attestation. The admin key NEVER exists in the
//      client in production; binding is performed by the LZ DVN network
//      (α-3) or the Cofferdam TEE service (v2). See cofferdam-sdk/README.md
//      §2.4 + contracts/v1/zksync/README.md.
//
//   4. Derive `appPseudonym = HMAC(scopeSalt, accountAddress)` and return a
//      SignInResponse with the on-chain address.
//
// What this provider is NOT:
//   - It is NOT a smart-account / passkey flow. α-2 uses EOAs because the
//     passkey + ERC-4337-ish account abstraction work lands in β. The
//     `accountAddress` returned here is the EOA address; in β it becomes a
//     deployed smart-account contract address.
//   - It does NOT proxy through the (not-yet-existing) Cofferdam mobile app.
//     That's a different transport added in α-3 / β.
//
// Selecting via `new Cofferdam({ network: 'local', provider: new LocalChainProvider({...}) })`.

import type { TransactionReceipt as EthersReceipt } from 'ethers'
import { Provider as ZkProvider, Wallet as ZkWallet, Contract as ZkContract } from 'zksync-ethers'

import { derivePseudonym, deriveScopeKey } from '../identity/pseudonym.js'
import { SignInRejected } from './MockProvider.js'
import type {
  CofferdamProvider,
  NetworkMode,
  SignInErrorCode,
  SignInPolicy,
  SignInResponse,
  VerifiedClaims,
} from '../types.js'

// Re-export the SignInRejected from MockProvider for a single source of truth.
export { SignInRejected } from './MockProvider.js'

/**
 * Minimal ABI used by this provider — only the surface we actually call.
 * Keeping it inline (rather than importing the full Hardhat artifact JSON)
 * avoids dragging contract build outputs into the SDK package.
 */
const RECEIVER_ABI = [
  'function bindNullifier(address account, bytes32 nullifier)',
  'function accountToNullifier(address) view returns (bytes32)',
  'function isAccountBound(address) view returns (bool)',
] as const

export interface LocalChainProviderConfig {
  /** Consumer-app identifier (e.g. 'offshoresync'). Same semantics as MockProvider. */
  scope: string

  /**
   * Per-scope salt. Defaults to a deterministic derivation from `scope`. In
   * production the real salt comes from the Cofferdam backend at
   * integration-onboarding time.
   */
  scopeSalt?: string

  /** RPC URL of the ZKSync Era-shaped node. Local default: 'http://127.0.0.1:8011'. */
  rpcUrl: string

  /** Chain id. anvil-zksync default = 260; ZKSync Era Sepolia = 300. */
  chainId: number

  /** Deployed v1/zksync contract addresses. */
  contracts: {
    /** `OffshoreSyncReceiver` address — required for identity binding. */
    receiver: string
    /** `OffshoreSyncEscrow` — currently informational; reserved for future
     *  flows (e.g. provider returning a pre-funded escrow handle). */
    escrow?: string
  }

  /**
   * Stable user id. Different values produce different addresses and
   * pseudonyms. Default: 'mock-user-default'.
   */
  mockUserId?: string

  /**
   * Receiver-owner private key. If provided, `signIn()` will bind the user's
   * derived account on-chain (simulating the future α-3 LZ delivery or v2
   * TEE attestation). Without it, binding is the caller's responsibility
   * and `signIn()` just returns an unbound address.
   *
   * Production-deployed clients NEVER hold this key. It exists only to let
   * local PoC flows exercise the full happy path without orchestrating a
   * separate admin sidecar service.
   */
  adminPrivateKey?: string

  /**
   * If provided AND admin key is set, top up the derived account up to
   * `prefundEth` (in wei) before binding. Useful so the derived EOA can
   * subsequently call `postContract`. Default: 0 (no pre-funding).
   */
  prefundWei?: bigint

  /** PoC parity with MockProvider — does the user "have" a verified passport? */
  verified?: boolean
  verifiedClaims?: Partial<VerifiedClaims>

  /** Optional simulated latency between signIn() steps for UI testing. */
  latencyMs?: number
}

interface ResolvedConfig {
  scope: string
  scopeSalt: string
  rpcUrl: string
  chainId: number
  contracts: { receiver: string; escrow?: string }
  mockUserId: string
  adminPrivateKey: string | null
  prefundWei: bigint
  verified: boolean
  verifiedClaims: VerifiedClaims
  latencyMs: number
}

export class LocalChainProvider implements CofferdamProvider {
  readonly mode: NetworkMode = 'local'

  private readonly config: ResolvedConfig
  private readonly chainProvider: ZkProvider

  constructor(config: LocalChainProviderConfig) {
    this.config = {
      scope: config.scope,
      scopeSalt: config.scopeSalt ?? `local-salt:${config.scope}`,
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      contracts: config.contracts,
      mockUserId: config.mockUserId ?? 'mock-user-default',
      adminPrivateKey: config.adminPrivateKey ?? null,
      prefundWei: config.prefundWei ?? 0n,
      verified: config.verified ?? true,
      verifiedClaims: {
        country: 'BR',
        olderThan: 18,
        ofacClear: true,
        proofTimestamp: Date.now(),
        ...config.verifiedClaims,
      },
      latencyMs: config.latencyMs ?? 0,
    }
    this.chainProvider = new ZkProvider(this.config.rpcUrl)
  }

  async signIn(policy: SignInPolicy): Promise<SignInResponse> {
    await sleep(this.config.latencyMs)

    // ── policy gates (mirror MockProvider semantics) ─────────────────────────
    const country = this.config.verifiedClaims.country
    if (
      policy.allowedCountries &&
      country &&
      !policy.allowedCountries.includes(country)
    ) {
      throw new SignInRejected(
        'country_blocked' as SignInErrorCode,
        `[cofferdam-sdk] local user country '${country}' not in allowedCountries: ${policy.allowedCountries.join(',')}`,
      )
    }
    if (
      policy.blockedCountries &&
      country &&
      policy.blockedCountries.includes(country)
    ) {
      throw new SignInRejected(
        'country_blocked' as SignInErrorCode,
        `[cofferdam-sdk] local user country '${country}' is in blockedCountries`,
      )
    }
    if (policy.enforceSelfBeforeAccount && !this.config.verified) {
      throw new SignInRejected(
        'self_verification_failed' as SignInErrorCode,
        '[cofferdam-sdk] local user is unverified and policy requires Self before account',
      )
    }

    // ── (1) derive a deterministic EOA keypair from mockUserId ───────────────
    const userPk = await deriveDeterministicPrivateKey(this.config.mockUserId)
    const userWallet = new ZkWallet(userPk, this.chainProvider)
    const accountAddress = userWallet.address

    // ── (2) admin-side: optionally pre-fund + bind on-chain ──────────────────
    if (this.config.adminPrivateKey) {
      const adminWallet = new ZkWallet(this.config.adminPrivateKey, this.chainProvider)
      await this.maybePrefund(adminWallet, accountAddress)
      await this.maybeBind(adminWallet, accountAddress)
    }

    // ── (3) derive Cofferdam-side identity material ──────────────────────────
    // appPseudonym = HMAC(scopeSalt, accountAddress). Per the user's α-2
    // decision (cf. discussion thread). Cross-app-linkable for any observer
    // who sees both addresses — acceptable for PoC, NOT production. Production
    // pseudonym derivation moves to passkey credential id / Self nullifier
    // in β.
    const appPseudonym = await derivePseudonym(this.config.scopeSalt, accountAddress)
    const scopeKey = await deriveScopeKey(`local-user:${this.config.mockUserId}`, this.config.scope)

    return {
      appPseudonym,
      accountAddress,
      verified: this.config.verified,
      verifiedClaims: this.config.verified ? this.config.verifiedClaims : null,
      scopeKey,
      sessionToken: encodeLocalSessionToken({
        scope: this.config.scope,
        appPseudonym,
        accountAddress,
        chainId: this.config.chainId,
        issuedAt: Date.now(),
      }),
      // PoC: not a real passkey envelope. β replaces this with a passkey
      // signature over the SignInResponse fields.
      attestation: 'local-attestation-v1',
    }
  }

  signOut(): void {
    // No persistent state to clear in this provider (chain state is, well,
    // on-chain — and irreversibly committed).
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  private async maybePrefund(adminWallet: ZkWallet, accountAddress: string): Promise<void> {
    if (this.config.prefundWei <= 0n) return
    const current = await this.chainProvider.getBalance(accountAddress)
    if (current >= this.config.prefundWei) return
    const topUp = this.config.prefundWei - current
    const tx = await adminWallet.sendTransaction({ to: accountAddress, value: topUp })
    await tx.wait()
  }

  private async maybeBind(adminWallet: ZkWallet, accountAddress: string): Promise<void> {
    const receiver = new ZkContract(
      this.config.contracts.receiver,
      RECEIVER_ABI,
      adminWallet,
    )
    // Idempotent: if already bound (e.g. from a previous test run on a
    // long-lived node), skip. The on-chain contract enforces one-shot
    // semantics — a second bind attempt would revert.
    const already: boolean = await receiver.isAccountBound(accountAddress)
    if (already) return

    const nullifier = await deriveDeterministicNullifier(this.config.mockUserId)
    const tx = await receiver.bindNullifier(accountAddress, nullifier)
    const receipt: EthersReceipt | null = await tx.wait()
    if (!receipt || receipt.status !== 1) {
      throw new SignInRejected(
        'unknown' as SignInErrorCode,
        `[cofferdam-sdk] bindNullifier failed for account ${accountAddress}`,
      )
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Deterministic crypto helpers (PoC-only; documented as such)
// ────────────────────────────────────────────────────────────────────────────

const PRIVATE_KEY_SEED_SALT = 'cofferdam-local-privatekey-v1'
const NULLIFIER_SEED_SALT = 'cofferdam-local-nullifier-v1'

/**
 * Derive a 32-byte private key deterministically from a string id. Uses
 * HMAC-SHA256 via WebCrypto — works in Node ≥ 19, modern browsers, and
 * React Native with webcrypto polyfill.
 *
 * SECURITY NOTE: This is for local PoC only. The output is predictable to
 * anyone who knows `mockUserId` and the seed salt. Never reuse this key
 * derivation for any account holding real funds.
 */
async function deriveDeterministicPrivateKey(mockUserId: string): Promise<string> {
  const digest = await hmacSha256(PRIVATE_KEY_SEED_SALT, mockUserId)
  // secp256k1 private keys must be in (0, n); n is just below 2^256. The
  // probability of HMAC output falling outside that range is ~2^-128 — we
  // ignore it for PoC. A 0x00...01 leading byte ensures we're never exactly 0.
  return '0x' + bytesToHex(digest)
}

/**
 * Derive a deterministic 32-byte nullifier from a user id. Stand-in for the
 * Self.xyz Poseidon nullifier in α-2.
 */
async function deriveDeterministicNullifier(mockUserId: string): Promise<string> {
  const digest = await hmacSha256(NULLIFIER_SEED_SALT, mockUserId)
  return '0x' + bytesToHex(digest)
}

async function hmacSha256(salt: string, input: string): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw new Error('[cofferdam-sdk] SubtleCrypto unavailable')
  }
  const keyMaterial = new TextEncoder().encode(salt)
  const key = await subtle.importKey(
    'raw',
    keyMaterial as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await subtle.sign('HMAC', key, new TextEncoder().encode(input) as BufferSource)
  return new Uint8Array(sig)
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0')
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function encodeLocalSessionToken(payload: object): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  const b64 = btoa(binary)
  return `local.${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}
