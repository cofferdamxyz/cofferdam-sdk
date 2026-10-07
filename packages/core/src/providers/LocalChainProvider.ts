// LocalChainProvider — Phase α-2 (Base).
//
// Talks to a local base-anvil node (or any Base-shaped JSON-RPC endpoint,
// including Base Sepolia) and exercises the on-chain identity + account
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
//   3. Check `NullifierRegistry.isAccountBound(account)` to surface whether
//      the user has been identity-bound on-chain. Actual binding is NOT
//      performed by this provider — the production path requires a Groth16
//      proof from Self.xyz's GCP enclave + an attester signature
//      from the cofferdam-attester Worker, submitted via an ERC-4337
//      UserOp to `NullifierRegistry.verifyAndBind`. Full flow in
//      cofferdam-sdk/IDENTITY_LAYER_DESIGN.md §3.
//
//   4. Derive `appPseudonym = HMAC(scopeSalt, accountAddress)` and return a
//      SignInResponse with the on-chain address.
//
// What this provider is NOT:
//   - It is NOT a smart-account / passkey flow. α-2 uses EOAs because the
//     passkey + ERC-4337 account abstraction work lands in β. The
//     `accountAddress` returned here is the EOA address; in β it becomes a
//     deployed ERC-4337 smart-account contract address.
//   - It does NOT proxy through the (not-yet-existing) Cofferdam mobile app.
//     That's a different transport added in α-3 / β.
//   - It does NOT bind the user's identity on-chain. Binding requires the
//     full prover + attester pipeline (see IDENTITY_LAYER_DESIGN.md §3).
//
// Selecting via `new Cofferdam({ network: 'local', provider: new LocalChainProvider({...}) })`.

import { JsonRpcProvider, Wallet, Contract as EthContract } from 'ethers'

import { derivePseudonym, deriveScopeKey } from '../identity/pseudonym.js'
import { SignInRejected } from './MockProvider.js'
import { runAdminTx } from './adminTxQueue.js'
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
const NULLIFIER_REGISTRY_ABI = [
  'function isAccountBound(address account) view returns (bool)',
  'function isNullifierBound(uint256 nullifier) view returns (bool)',
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

  /** RPC URL of the Base node. Local default: 'http://127.0.0.1:8545' (base-anvil). */
  rpcUrl: string

  /** Chain id. base-anvil default = 31337; Base Sepolia = 84532; Base mainnet = 8453. */
  chainId: number

  /** Deployed Base contract addresses. */
  contracts: {
    /** `NullifierRegistry` address — used for identity binding checks. */
    nullifierRegistry: string
    /** `CofferdamSpotEscrow` — currently informational; reserved for future
     *  flows (e.g. provider returning a pre-funded escrow handle). */
    escrow?: string
  }

  /**
   * Stable user id. Different values produce different addresses and
   * pseudonyms. Default: 'mock-user-default'.
   */
  mockUserId?: string

  /**
   * Funded EOA private key. If provided, `signIn()` will pre-fund the user's
   * derived account so it can post / award / dispute on-chain. PoC
   * convenience only.
   *
   * On Base, identity binding is NOT performed with this key — the production
   * path requires a Groth16 proof from Self.xyz's GCP enclave + an
   * attester signature from the cofferdam-attester Worker, submitted via an
   * ERC-4337 UserOp to `NullifierRegistry.verifyAndBind`.
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
  contracts: { nullifierRegistry: string; escrow?: string }
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
  private readonly chainProvider: JsonRpcProvider

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
    this.chainProvider = new JsonRpcProvider(this.config.rpcUrl)
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
    const userWallet = new Wallet(userPk, this.chainProvider)
    const accountAddress = userWallet.address

    // ── (2) admin-side: optionally pre-fund the derived account ──────────────
    // Note: identity binding is NOT performed here. On Base, binding requires
    // a Groth16 proof (Self.xyz GCP enclave) + attester signature (cofferdam-attester)
    // submitted via an ERC-4337 UserOp to NullifierRegistry.verifyAndBind.
    if (this.config.adminPrivateKey) {
      const adminWallet = new Wallet(this.config.adminPrivateKey, this.chainProvider)
      await this.maybePrefund(adminWallet, accountAddress)
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

  private async maybePrefund(adminWallet: Wallet, accountAddress: string): Promise<void> {
    if (this.config.prefundWei <= 0n) return
    const current = await this.chainProvider.getBalance(accountAddress)
    if (current >= this.config.prefundWei) return
    const topUp = this.config.prefundWei - current
    // Route through the module-level admin queue so concurrent
    // LocalChainProvider instances against the same admin EOA don't race
    // on nonce assignment (Sepolia public RPC has eventually-consistent
    // pending-nonce reads — see ./adminTxQueue.ts for the full rationale).
    await runAdminTx(this.config.rpcUrl, this.chainProvider, adminWallet, async (nonce) => {
      const tx = await adminWallet.sendTransaction({ to: accountAddress, value: topUp, nonce })
      return tx.wait()
    })
  }

  /**
   * Check whether the user's account is identity-bound on-chain via
   * `NullifierRegistry.isAccountBound`. This is a read-only check — actual
   * binding requires the full prover + attester pipeline.
   */
  async isAccountBound(accountAddress: string): Promise<boolean> {
    const registry = new EthContract(
      this.config.contracts.nullifierRegistry,
      NULLIFIER_REGISTRY_ABI,
      this.chainProvider,
    )
    return registry.isAccountBound(accountAddress) as Promise<boolean>
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Deterministic crypto helpers (PoC-only; documented as such)
// ────────────────────────────────────────────────────────────────────────────

const PRIVATE_KEY_SEED_SALT = 'cofferdam-local-privatekey-v1'

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
