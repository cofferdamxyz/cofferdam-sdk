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
  tierOf,
  isUntrustedLowTier,
  chooseEnrollmentLane,
  evaluateUpgrade,
  assertCanEnrollFirstPasskey,
  authorityStateFromResponse,
  nextMigrationStatus,
  DEFAULT_DEVICE_CAPABILITY,
  PasskeyUpgradeError,
  UpgradePathLockedError,
  AlreadyHighTierError,
  ManagedAuthorityNotUpgradableError,
  PasskeyUpgradeUnsupportedError,
  type LanePolicy,
  type MigrationEvent,
} from './identity/authority.js'
export {
  CofferdamSpotEscrowClient,
  COFFERDAM_SPOT_ESCROW_ABI,
  OPEN_FUNDING,
  type CofferdamSpotEscrowClientConfig,
  type PostResult,
  type TxResult,
  type TxOptions,
  type JobContractState,
  type JobContractStatus,
} from './escrow/CofferdamSpotEscrowClient.js'

export type {
  AuthorityDescriptor,
  AuthorityKind,
  AuthorityState,
  AuthorityTier,
  CofferdamConfig,
  CofferdamProvider,
  Country,
  DeviceCapability,
  EnrollFirstPasskeyOptions,
  EnrollmentLane,
  MigrationStatus,
  NetworkMode,
  PasskeyEnrollmentResult,
  PasskeyUpgradeDirective,
  SelectiveClaim,
  SignInErrorCode,
  SignInPolicy,
  SignInResponse,
  UpgradeReason,
  VerifiedClaims,
} from './types.js'
