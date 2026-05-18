// Public API surface for @cofferdam/sdk.
//
// Pre-stable (v0.x); see cofferdam-sdk/README.md §10 — Versioning + release
// policy.

export { Cofferdam } from './Cofferdam.js'
export {
  MockProvider,
  SignInRejected,
  type MockProviderConfig,
} from './providers/MockProvider.js'
export { derivePseudonym, deriveScopeKey } from './identity/pseudonym.js'

export type {
  CofferdamConfig,
  CofferdamProvider,
  Country,
  NetworkMode,
  SelectiveClaim,
  SignInErrorCode,
  SignInPolicy,
  SignInResponse,
  VerifiedClaims,
} from './types.js'
