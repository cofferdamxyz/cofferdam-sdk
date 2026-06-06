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
  /**
   * Opt in to an in-browser, origin-bound platform-authenticator passkey as the
   * high-tier signer (IDENTITY_LAYER_DESIGN.md §3.12 C3 lane (b)). Default false
   * ⇒ the SDK prefers the QR handoff to the Cofferdam RN app (the canonical,
   * portable key).
   */
  allowInBrowserPasskey?: boolean
}

export interface VerifiedClaims {
  country?: Country
  olderThan?: 18 | 21 | 25
  ofacClear?: boolean
  proofTimestamp: number
}

// ── Tiered authority model (rev-7.7) ─────────────────────────────────────────
// Full spec: cofferdam-sdk/IDENTITY_LAYER_DESIGN.md §2.5 (authority tiers + the
// one-way upgrade ratchet) and §3.12 (the consumer password→passkey migration).
// The on-chain `CofferdamAccountValidator` is the real enforcer
// (contracts/WEB3_CONVERSION.md §3.1); these types model it client-side.

/**
 * What kind of authority established / signed a session.
 * - 'passkey'       — a device passkey (P-256, Secure Enclave / StrongBox).
 * - 'password'      — a consumer's local password login.
 * - 'oauth_google' / 'oauth_apple' — a consumer's social OAuth login.
 * - 'polis_sso'     — an enterprise Polis SSO session (managed authority).
 */
export type AuthorityKind =
  | 'passkey'
  | 'password'
  | 'oauth_google'
  | 'oauth_apple'
  | 'polis_sso'

/**
 * Authority tier on the smart account (AA):
 * - 'high'          — a device passkey. May sign anything.
 * - 'low_untrusted' — a leakable credential (password / social OAuth). May only
 *                     authorise the FIRST passkey enrolment, then is locked out
 *                     by the one-way ratchet (§2.5.2).
 * - 'low_managed'   — an IdP-brokered, centrally SCIM-revocable Polis SSO
 *                     authority. NOT ratchet-locked; upgraded via the
 *                     enterprise addAuthority OR-semantics path (§3.10), never
 *                     via the consumer ratchet.
 */
export type AuthorityTier = 'high' | 'low_untrusted' | 'low_managed'

/** Mirror of the consumer-side `wallet.migrationStatus` (WEB3_CONVERSION §5.4). */
export type MigrationStatus = 'pending' | 'enrolled' | 'declined'

/**
 * Which lane a first-passkey enrolment takes (§3.12 C3):
 * - 'qr_handoff' — DEFAULT. QR / deep-link to the Cofferdam RN app, whose
 *                  hardware-bound Secure-Enclave passkey is the canonical,
 *                  portable signer.
 * - 'in_browser' — OPT-IN per consumer. A first-party, origin-bound platform
 *                  authenticator (non-portable).
 */
export type EnrollmentLane = 'qr_handoff' | 'in_browser'

/** Device / surface capabilities that decide the enrolment lane (§3.12 C3). */
export interface DeviceCapability {
  /** A platform WebAuthn authenticator is present (Touch ID / Face ID / Hello). */
  hasPlatformAuthenticator: boolean
  /** An in-browser passkey is acceptable as a high-tier signer for THIS surface. */
  inBrowserPasskeyReliable: boolean
  /** A Cofferdam RN app is reachable for the QR / deep-link handoff. */
  nativeAppReachable: boolean
}

/** The authority that signed a session + its tier. */
export interface AuthorityDescriptor {
  kind: AuthorityKind
  tier: AuthorityTier
}

/** Snapshot of the AA's authority situation, used to drive the ratchet. */
export interface AuthorityState {
  /** Authority that established the current session. */
  active: AuthorityDescriptor
  /** High-tier device passkeys currently registered on the AA (≤ 3). */
  passkeyCount: number
  /**
   * True once the one-way ratchet has fired: a passkey exists, so an untrusted
   * low-tier authority can no longer add / remove authorities (§2.5.2).
   */
  upgradeLocked: boolean
  /** False ⇒ the AA is still counterfactual (not deployed) — §3.12 C2. */
  accountDeployed: boolean
  migrationStatus: MigrationStatus
}

/** Why a passkey upgrade is being surfaced. */
export type UpgradeReason =
  | 'untrusted_low_tier_no_passkey'
  | 'add_backup_device'
  | 'install_app_required'

/** Orchestration-derived next step for the consumer app (§3.12). */
export interface PasskeyUpgradeDirective {
  /** The consumer SHOULD surface a passkey-enrolment prompt. */
  recommended: boolean
  /**
   * The session cannot reach high-tier (self-custody) without this. True for an
   * untrusted low-tier login that has no passkey yet.
   */
  required: boolean
  /** Lane the SDK will take (the consumer may override via upgradeToPasskey). */
  lane: EnrollmentLane
  reason: UpgradeReason
}

export interface EnrollFirstPasskeyOptions {
  lane: EnrollmentLane
}

/** Result of a successful first-passkey enrolment (the ratchet has fired). */
export interface PasskeyEnrollmentResult {
  accountAddress: string
  accountDeployed: true
  /** Opaque WebAuthn credential id of the newly-registered passkey. */
  passkeyCredentialId: string
  authority: AuthorityDescriptor
  migrationStatus: 'enrolled'
  upgradeLocked: true
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

  /**
   * Authority that established this session + its tier (rev-7.7). Absent for
   * providers that predate the tiered-authority model.
   */
  authority?: AuthorityDescriptor

  /** Consumer-side migration mirror (WEB3_CONVERSION §5.4). */
  migrationStatus?: MigrationStatus

  /**
   * False when the AA is counterfactual (deployed lazily on first-passkey
   * enrolment) — IDENTITY_LAYER_DESIGN.md §3.12 C2. Absent ⇒ treat as deployed.
   */
  accountDeployed?: boolean

  /**
   * Orchestration-derived next-step directive (set by `Cofferdam.signIn`).
   * `null` ⇒ nothing to do; absent ⇒ the provider does not model tiers.
   */
  upgrade?: PasskeyUpgradeDirective | null
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

  // ── Tiered-authority extensions (rev-7.7; optional for back-compat) ─────────
  /** Current authority snapshot for the signed-in user. */
  getAuthorityState?(): Promise<AuthorityState>
  /** Capabilities of the current device / surface (drives the enrolment lane). */
  deviceCapability?(): DeviceCapability
  /**
   * Enrol the FIRST device passkey (high-tier) and deploy the counterfactual
   * AA, firing the one-way ratchet. MUST reject if the ratchet has already
   * fired or the active authority is not an upgradable untrusted low-tier.
   */
  enrollFirstPasskey?(opts: EnrollFirstPasskeyOptions): Promise<PasskeyEnrollmentResult>
  /** Record that the user declined the passkey upgrade (migrationStatus='declined'). */
  declineMigration?(): Promise<void>
}

export type SignInErrorCode =
  | 'cancelled'
  | 'no_passkey'
  | 'self_verification_failed'
  | 'country_blocked'
  | 'unknown'
