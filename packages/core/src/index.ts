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
export {
  LocalChainProvider,
  type LocalChainProviderConfig,
} from './providers/LocalChainProvider.js'
export {
  mockProfiles,
  getMockProfile,
  type MockProfile,
  type MockProfileName,
} from './providers/mockProfiles.js'
export { derivePseudonym, deriveScopeKey } from './identity/pseudonym.js'
export {
  OffshoreSyncEscrowClient,
  OFFSHORESYNC_ESCROW_ABI,
  OPEN_FUNDING,
  type OffshoreSyncEscrowClientConfig,
  type PostResult,
  type TxResult,
  type TxOptions,
  type JobContractState,
  type JobContractStatus,
} from './escrow/OffshoreSyncEscrowClient.js'

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
