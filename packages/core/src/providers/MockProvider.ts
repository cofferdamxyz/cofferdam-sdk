// In-process mock provider — Phase α-1.
//
// Stands in for the (not-yet-existing) Cofferdam mobile app. Returns
// deterministic-but-realistic SignInResponse values so the consumer-app
// integration (OffshoreSync react-client) can be developed and tested
// before any chain, any deep-link, and any real Cofferdam app exist.
//
// Replaced by:
//   - LocalChainProvider   in α-2 (real chain, no real mobile app)
//   - TestnetProvider      in α-3 (real testnet + real Cofferdam mobile shell)
//   - ProductionProvider   in β  (mainnet + real Cofferdam app)
//
// Selecting via `new Cofferdam({ network: 'mock', ... })`.

import { derivePseudonym, deriveScopeKey } from '../identity/pseudonym.js'
import type {
  CofferdamProvider,
  NetworkMode,
  SignInErrorCode,
  SignInPolicy,
  SignInResponse,
  VerifiedClaims,
} from '../types.js'

export interface MockProviderConfig {
  scope: string
  /**
   * Override the per-scope salt. Defaults to a deterministic derivation from
   * the scope string. In production, the real salt comes from the Cofferdam
   * backend at integration-onboarding time.
   */
  scopeSalt?: string
  /**
   * Stable mock user identifier. Different values produce different
   * pseudonyms and account addresses. Default: 'mock-user-default'.
   */
  mockUserId?: string
  /** Whether the mock user has completed Self verification. Default: true. */
  verified?: boolean
  verifiedClaims?: Partial<VerifiedClaims>
  /**
   * Simulated async latency (ms). Lets UI exercise loading / pending states.
   * Default: 250.
   */
  latencyMs?: number
}

interface ResolvedMockConfig {
  scope: string
  scopeSalt: string
  mockUserId: string
  verified: boolean
  verifiedClaims: VerifiedClaims
  latencyMs: number
}

export class SignInRejected extends Error {
  readonly code: SignInErrorCode

  constructor(code: SignInErrorCode, message?: string) {
    super(message ?? `[cofferdam-sdk] sign-in rejected: ${code}`)
    this.name = 'SignInRejected'
    this.code = code
  }
}

export class MockProvider implements CofferdamProvider {
  readonly mode: NetworkMode = 'mock'

  private readonly config: ResolvedMockConfig

  constructor(config: MockProviderConfig) {
    this.config = {
      scope: config.scope,
      scopeSalt: config.scopeSalt ?? `mock-salt:${config.scope}`,
      mockUserId: config.mockUserId ?? 'mock-user-default',
      verified: config.verified ?? true,
      verifiedClaims: {
        country: 'BR',
        olderThan: 18,
        ofacClear: true,
        proofTimestamp: Date.now(),
        ...config.verifiedClaims,
      },
      latencyMs: config.latencyMs ?? 250,
    }
  }

  async signIn(policy: SignInPolicy): Promise<SignInResponse> {
    await sleep(this.config.latencyMs)

    // Country gating (policy enforcement on the mock side; production
    // enforcement is defense-in-depth across SDK + Cofferdam backend +
    // optionally on-chain).
    const country = this.config.verifiedClaims.country
    if (
      policy.allowedCountries &&
      country &&
      !policy.allowedCountries.includes(country)
    ) {
      throw new SignInRejected(
        'country_blocked',
        `[cofferdam-sdk] mock user country '${country}' not in allowedCountries: ${policy.allowedCountries.join(',')}`,
      )
    }
    if (
      policy.blockedCountries &&
      country &&
      policy.blockedCountries.includes(country)
    ) {
      throw new SignInRejected(
        'country_blocked',
        `[cofferdam-sdk] mock user country '${country}' is in blockedCountries`,
      )
    }

    // Strict-mode policy: if the consumer app requires Self-before-account
    // and the mock user isn't verified, fail. Default policy (false) lets
    // unverified users sign in (Self is value-gated; see README §2.4).
    if (policy.enforceSelfBeforeAccount && !this.config.verified) {
      throw new SignInRejected(
        'self_verification_failed',
        '[cofferdam-sdk] mock user is unverified and policy requires Self before account',
      )
    }

    const nullifier = `mock-nullifier:${this.config.mockUserId}`
    const appPseudonym = await derivePseudonym(
      this.config.scopeSalt,
      nullifier,
    )
    const accountAddress = await deriveMockAddress(this.config.mockUserId)
    const scopeKey = await deriveScopeKey(nullifier, this.config.scope)

    return {
      appPseudonym,
      accountAddress,
      verified: this.config.verified,
      verifiedClaims: this.config.verified ? this.config.verifiedClaims : null,
      scopeKey,
      sessionToken: encodeMockSessionToken({
        scope: this.config.scope,
        appPseudonym,
        issuedAt: Date.now(),
      }),
      attestation: 'mock-attestation-v1',
    }
  }

  signOut(): void {
    // No persistent state to clear in this provider.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Deterministic 20-byte "address" derived from the mock user identifier.
 * NEVER on-chain; purely a visual stand-in so dashboards / dev UIs show
 * something address-shaped during α-1.
 */
async function deriveMockAddress(mockUserId: string): Promise<string> {
  const input = `mock-account|${mockUserId}|cofferdam-mock-account-v1`
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw new Error('[cofferdam-sdk] SubtleCrypto unavailable')
  }
  const digest = new Uint8Array(
    await subtle.digest('SHA-256', new TextEncoder().encode(input) as BufferSource),
  )
  // Use the last 20 bytes (Ethereum-address-shaped).
  let hex = ''
  for (let i = digest.length - 20; i < digest.length; i++) {
    hex += digest[i]!.toString(16).padStart(2, '0')
  }
  return `0x${hex}`
}

/**
 * Mock session-token encoder. Base64url of JSON. NOT signed, NOT verified.
 * Production tokens are passkey-signed envelopes (β phase).
 */
function encodeMockSessionToken(payload: object): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  const b64 = btoa(binary)
  return `mock.${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}
