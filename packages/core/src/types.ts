// Public type surface for @cofferdam/sdk.
//
// These types are derived from cofferdam-sdk/README.md §3 (Consumer-app
// enforcement policies) and §4 (API surface). v0.x is pre-stable; the API
// may change between minor versions.

export type NetworkMode = 'mock' | 'local' | 'testnet' | 'mainnet'

/** ISO-3166 alpha-2 country code (e.g. 'BR', 'US', 'NG'). */
export type Country = string

export type SelectiveClaim =
  | 'country'
  | 'olderThan:18'
  | 'olderThan:21'
  | 'olderThan:25'
  | 'ofacClear'
  | 'nationality'

export interface SignInPolicy {
  /**
   * If true, the smart account is not deployed until Self.xyz verification +
   * LayerZero V2 callback both complete. Strict-mode (regulated apps).
   * Default: false (passkey + smart account immediately; Self deferred to
   * value-gated triggers — see cofferdam-sdk/README.md §2.4).
   */
  enforceSelfBeforeAccount?: boolean
  /** Seconds since the user's last Self proof. */
  requireVerifiedWithin?: number
  requireClaims?: SelectiveClaim[]
  allowedCountries?: Country[]
  blockedCountries?: Country[]
  /** Seconds since the last passkey signature; useful for high-value actions. */
  requirePasskeyFreshness?: number
}

export interface VerifiedClaims {
  country?: Country
  olderThan?: 18 | 21 | 25
  ofacClear?: boolean
  proofTimestamp: number
}

export interface SignInResponse {
  /**
   * Per-app stable identifier. Store as the user's primary key in your DB.
   * Derived as H(scopeSalt[your-app] || nullifier(user) || domain-sep)
   * entirely on the user's device; the nullifier itself never reaches you.
   * See cofferdam-sdk/README.md §5.6.
   */
  appPseudonym: string

  /**
   * ZKSync Era smart-account address. Use ONLY for chain-relevant operations.
   * Do NOT use as your primary user key — use appPseudonym for that.
   */
  accountAddress: string

  verified: boolean
  verifiedClaims: VerifiedClaims | null

  /** Per-consumer-app encryption sub-key. */
  scopeKey: string

  /** Short-lived token for follow-up SDK calls in this session. */
  sessionToken: string

  /** Passkey-signed envelope binding the response. */
  attestation: string
}

export interface CofferdamConfig {
  /** Registered app identifier (e.g. 'offshoresync'). */
  scope: string
  scopeDisplayName: string
  scopeIcon?: string
  network?: NetworkMode
  policy?: SignInPolicy
  /**
   * Custom provider. If omitted, network='mock' auto-constructs a MockProvider;
   * other network modes require an explicit provider until α-2 / α-3 ship
   * the LocalChainProvider / TestnetProvider.
   */
  provider?: CofferdamProvider
}

/**
 * Provider abstraction. Concrete implementations:
 * - MockProvider          — α-1 (this file's package)
 * - LocalChainProvider    — α-2 (talks to anvil-zksync via viem)
 * - TestnetProvider       — α-3 (ZKSync Era Sepolia; single-chain post rev-6,
 *                                Celo Alfajores removed from production path)
 * - ProductionProvider    — β  (mainnet + real Cofferdam mobile app deep-link)
 */
export interface CofferdamProvider {
  readonly mode: NetworkMode
  signIn(policy: SignInPolicy): Promise<SignInResponse>
  signOut?(): void
}

export type SignInErrorCode =
  | 'cancelled'
  | 'no_passkey'
  | 'self_verification_failed'
  | 'country_blocked'
  | 'unknown'
