// Named mock-user fixtures for development, QA matrices, and screenshot
// generation in consumer apps (OffshoreSync, examples/capacitor-minimal,
// future integrations).
//
// Each profile is a partial MockProviderConfig (everything except `scope`,
// which the consumer app supplies). Spread the chosen profile into a new
// MockProvider:
//
//   import { MockProvider, mockProfiles } from '@cofferdam/sdk/mock'
//
//   const provider = new MockProvider({
//     scope: 'offshoresync',
//     ...mockProfiles['verified-br'],
//   })
//
// Profiles are intentionally limited to the small set that exercises every
// SignInPolicy gate documented in cofferdam-sdk/README.md §3:
//
//   - Country allow/block lists       → verified-br, verified-us
//   - Self verification requirement   → unverified
//   - OFAC clearance                  → ofac-flagged
//   - requireVerifiedWithin freshness → stale-proof
//
// Each profile has a stable `mockUserId` so its derived `appPseudonym` and
// `accountAddress` are deterministic across runs — useful for snapshot tests
// and UI screenshots that need byte-identical output.

import type { MockProviderConfig } from './MockProvider.js'

/**
 * The fixture shape: everything a `MockProvider` needs except `scope`.
 * Consumers supply `scope` themselves (it is app-identity, not test data).
 */
export type MockProfile = Omit<MockProviderConfig, 'scope'>

/**
 * Named profile keys. Type-safe lookup: `mockProfiles[name]` is checked.
 */
export type MockProfileName =
  | 'verified-br'
  | 'verified-us'
  | 'unverified'
  | 'ofac-flagged'
  | 'stale-proof'

const ONE_DAY_MS = 86_400_000

/**
 * Built-in mock-user fixtures. Each entry is a complete drop-in for the
 * `verified` / `verifiedClaims` / `mockUserId` slots of `MockProviderConfig`.
 *
 * Stability contract: the SDK guarantees that within a given semver-minor
 * release, a given profile name maps to a fixed `mockUserId` (and therefore
 * a fixed derived `appPseudonym` / `accountAddress`). New profiles may be
 * added in minor releases; existing profiles' identifiers will not change.
 */
export const mockProfiles: Record<MockProfileName, MockProfile> = {
  /**
   * Default-shaped verified user. Brazilian, 18+, OFAC-clear, fresh proof.
   * Use this when you just need "a happy-path verified user" — it's what
   * the bare `new MockProvider({ scope })` constructor falls back to.
   */
  'verified-br': {
    mockUserId: 'mock-verified-br',
    verified: true,
    verifiedClaims: {
      country: 'BR',
      olderThan: 18,
      ofacClear: true,
      proofTimestamp: Date.now(),
    },
  },

  /**
   * Verified U.S. user, 21+, OFAC-clear. Use to exercise consumer-app
   * country gates: e.g. an app that calls `signIn({ blockedCountries: ['US'] })`
   * should reject this profile with `country_blocked`.
   */
  'verified-us': {
    mockUserId: 'mock-verified-us',
    verified: true,
    verifiedClaims: {
      country: 'US',
      olderThan: 21,
      ofacClear: true,
      proofTimestamp: Date.now(),
    },
  },

  /**
   * Unverified user. Soft-mode default per cofferdam-sdk/README.md §2.4 —
   * the smart account exists, but Self.xyz verification has not been
   * completed. Apps using `enforceSelfBeforeAccount: true` will reject this
   * profile with `self_verification_failed`.
   */
  unverified: {
    mockUserId: 'mock-unverified',
    verified: false,
  },

  /**
   * Verified user but OFAC-flagged. Useful for testing compliance UI:
   * the app receives a `verified: true` response with `ofacClear: false`
   * in `verifiedClaims`, and is responsible for surfacing the appropriate
   * sanctions-screening flow (see cofferdam-app/ARCHITECTURE.md §6).
   *
   * Country code 'XX' is the ISO-3166 alpha-2 user-assigned range — the
   * SDK does not attempt to resolve it, and this profile pairs naturally
   * with apps that fall back to `ofacClear` rather than country-only logic.
   */
  'ofac-flagged': {
    mockUserId: 'mock-ofac-flagged',
    verified: true,
    verifiedClaims: {
      country: 'XX',
      olderThan: 18,
      ofacClear: false,
      proofTimestamp: Date.now(),
    },
  },

  /**
   * Verified user with a stale Self proof (200 days old). Use to test the
   * `requireVerifiedWithin` policy gate: an app calling
   * `signIn({ requireVerifiedWithin: 90 * 86400 })` against this profile
   * should reject and prompt the user to re-verify.
   *
   * The mock provider does NOT enforce `requireVerifiedWithin` itself in α-1
   * (it returns the response and lets the consumer app decide); this profile
   * just supplies the data the app needs to make that decision.
   */
  'stale-proof': {
    mockUserId: 'mock-stale-proof',
    verified: true,
    verifiedClaims: {
      country: 'BR',
      olderThan: 18,
      ofacClear: true,
      proofTimestamp: Date.now() - 200 * ONE_DAY_MS,
    },
  },
}

/**
 * Type-safe profile lookup with helpful error messages on typos.
 *
 * Prefer `mockProfiles[name]` for compile-time-checked profile names; use
 * this helper when the name comes from a runtime source like an env var.
 */
export function getMockProfile(name: string): MockProfile {
  if (!Object.prototype.hasOwnProperty.call(mockProfiles, name)) {
    const available = Object.keys(mockProfiles).join(', ')
    throw new Error(
      `[cofferdam-sdk] unknown mock profile: '${name}'. Available: ${available}.`,
    )
  }
  return mockProfiles[name as MockProfileName]
}
