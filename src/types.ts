// Public type surface for @cofferdam/sdk.
//
// Documented in the repository README and the workspace
// `docs/architecture/sdk.md`. v0.x is pre-stable; the API may change between
// minor versions.

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
   * If true, the app waits for a Self.xyz binding before it uses the account.
   * Strict mode (regulated apps). Default: false (the account is counterfactual
   * and deploys with its first sponsored op; Self is a payout gate).
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
   * high-tier signer (workspace `docs/architecture/identity.md`). Default false
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

// ── Tiered authority model ─────────────────────────────────────────────────────
// Current model: workspace `docs/architecture/identity.md` (High, Partner,
// Managed; decision 0016). `low_untrusted` and the ratchet below are code debt
// from the retired model (see `docs/architecture/sdk.md`).
// The on-chain `CofferdamAccount4337` is the real enforcer
// (base-contracts/contracts/account/CofferdamAccount4337.sol); these types
// model it client-side.

/**
 * What kind of authority established / signed a session.
 * - 'passkey'       — a device passkey (P-256, Secure Enclave / StrongBox).
 * - 'password'      — a consumer's local password login.
 * - 'oauth_google' / 'oauth_apple' — a consumer's social OAuth login.
 * - 'polis_sso'     — an enterprise Polis SSO session (managed authority).
 * - 'partner_passkey' — the user's own passkey on a partner app's RP
 *                     (`PartnerPasskeyAuthority`; decision 0016).
 */
export type AuthorityKind =
  | 'passkey'
  | 'password'
  | 'oauth_google'
  | 'oauth_apple'
  | 'polis_sso'
  | 'partner_passkey'

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
 * - 'partner'       — the user's own passkey on a partner app's RP: scoped job
 *                     calls from its `Permission`, zero value, no authority
 *                     changes, no ERC-1271 (decision 0016). Mirrors on-chain
 *                     `Tier.Partner` (4).
 */
export type AuthorityTier = 'high' | 'low_untrusted' | 'low_managed' | 'partner'

/** Mirror of the consumer-side `wallet.migrationStatus` (retired ratchet model; code debt). */
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
   * Derived on the device with HKDF (`identity/pseudonym.ts`). The native
   * provider keys it on the account address today, which changes per account
   * generation: open question in the workspace `docs/architecture/sdk.md`.
   */
  appPseudonym: string

  /**
   * Base smart-account address (ERC-4337 account or EOA). Use ONLY for
   * chain-relevant operations. Do NOT use as your primary user key —
   * use appPseudonym for that.
   */
  accountAddress: string

  /**
   * Whether a Self.xyz passport is bound to the account. `NativeAccountProvider`
   * reads `NullifierRegistry.isAccountBound(account)` at sign-in and signs the
   * answer into `attestation` (false without `contracts.nullifierRegistry`);
   * `MockProvider` returns its fixture. A relying party that depends on the
   * binding reads the registry itself.
   */
  verified: boolean
  /**
   * Nationality, age and OFAC claims. Always `null` from `NativeAccountProvider`:
   * they are not on-chain and the plane does not issue them yet. `MockProvider`
   * returns its fixture.
   */
  verifiedClaims: VerifiedClaims | null

  /** Per-consumer-app encryption sub-key. */
  scopeKey: string

  /** Short-lived token for follow-up SDK calls in this session. */
  sessionToken: string

  /**
   * Passkey-signed envelope binding the security-relevant response fields
   * (`scope`, `appPseudonym`, `accountAddress`, `chainId`, `verified`,
   * `issuedAt`) so a consumer can cryptographically verify the session origin.
   * A `csa1:`-prefixed token; decode + verify with
   * `decodeAndVerifySessionAttestation`. (`MockProvider` returns an opaque
   * placeholder that does not verify.)
   */
  attestation: string

  /**
   * Authority that established this session + its tier (rev-7.7). Absent for
   * providers that predate the tiered-authority model.
   */
  authority?: AuthorityDescriptor

  /** Consumer-side migration mirror (retired ratchet model; code debt). */
  migrationStatus?: MigrationStatus

  /**
   * False when the AA is counterfactual (deployed lazily on first-passkey
   * enrolment) — workspace `docs/architecture/identity.md`. Absent ⇒ treat as deployed.
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
 * Provider abstraction. Implementations:
 * - MockProvider          — in-memory, for UI development
 * - LocalChainProvider    — talks to a local base-anvil node via ethers
 * - NativeAccountProvider — real ERC-4337 accounts on Base (`@cofferdam/sdk/native`)
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
