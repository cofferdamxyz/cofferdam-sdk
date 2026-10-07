import type { MockProviderConfig } from './MockProvider.js';
/**
 * The fixture shape: everything a `MockProvider` needs except `scope`.
 * Consumers supply `scope` themselves (it is app-identity, not test data).
 */
export type MockProfile = Omit<MockProviderConfig, 'scope'>;
/**
 * Named profile keys. Type-safe lookup: `mockProfiles[name]` is checked.
 */
export type MockProfileName = 'verified-br' | 'verified-us' | 'unverified' | 'ofac-flagged' | 'stale-proof';
/**
 * Built-in mock-user fixtures. Each entry is a complete drop-in for the
 * `verified` / `verifiedClaims` / `mockUserId` slots of `MockProviderConfig`.
 *
 * Stability contract: the SDK guarantees that within a given semver-minor
 * release, a given profile name maps to a fixed `mockUserId` (and therefore
 * a fixed derived `appPseudonym` / `accountAddress`). New profiles may be
 * added in minor releases; existing profiles' identifiers will not change.
 */
export declare const mockProfiles: Record<MockProfileName, MockProfile>;
/**
 * Type-safe profile lookup with helpful error messages on typos.
 *
 * Prefer `mockProfiles[name]` for compile-time-checked profile names; use
 * this helper when the name comes from a runtime source like an env var.
 */
export declare function getMockProfile(name: string): MockProfile;
//# sourceMappingURL=mockProfiles.d.ts.map