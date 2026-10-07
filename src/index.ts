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
  NativeAccountProvider,
  PasskeyCapReachedError,
  MAX_PASSKEYS,
  type NativeAccountProviderConfig,
  type NativeTxRequest,
  type AuthorityRecord,
  type GenesisAuthorityConfig,
} from './providers/NativeAccountProvider.js'
export {
  encodeSessionConfig,
  signSessionInner,
  deriveSessionSigner,
  type SessionSigner,
} from './identity/sessionKey.js'
export {
  DeterministicPasskeySigner,
  encodePasskeyConfig,
  p256PublicKey,
  signP256Digest,
  verifyP256Digest,
  type PasskeySigner,
  type PasskeySignatureScheme,
  type P256PublicKey,
} from './identity/passkey.js'
export {
  WebAuthnPasskeySigner,
  softwareWebAuthnAuthenticator,
  softwareWebAuthnPublicKey,
  p256PublicKeyFromDer,
  derSignatureToRS,
  encodeWebAuthnInnerSignature,
  decodeWebAuthnInnerSignature,
  verifyWebAuthnAssertion,
  webAuthnConfig,
  base64urlToBytes,
  bytesToBase64url,
  type WebAuthnAssertion,
  type WebAuthnAuthenticator,
  type DecodedWebAuthnAuth,
} from './identity/webauthn.js'
export {
  createDeviceHandoff,
  encodeDeviceHandoff,
  decodeDeviceHandoff,
  verifyDeviceHandoff,
  decodeAndVerifyDeviceHandoff,
  deviceHandoffDigest,
  DeviceHandoffError,
  DeviceHandoffDecodeError,
  DeviceHandoffExpiredError,
  DeviceHandoffLivenessError,
  DEVICE_HANDOFF_VERSION,
  MAX_DEVICE_LABEL_LENGTH,
  DEFAULT_HANDOFF_MAX_AGE_MS,
  type DeviceHandoff,
  type DeviceHandoffFields,
} from './identity/deviceHandoff.js'
export {
  mockProfiles,
  getMockProfile,
  type MockProfile,
  type MockProfileName,
} from './providers/mockProfiles.js'
export {
  createSessionAttestation,
  signSessionAttestation,
  encodeSessionAttestation,
  decodeSessionAttestation,
  verifySessionAttestation,
  decodeAndVerifySessionAttestation,
  sessionAttestationDigest,
  SessionAttestationError,
  SessionAttestationDecodeError,
  SessionAttestationExpiredError,
  SessionAttestationVerificationError,
  SESSION_ATTESTATION_VERSION,
  type SessionAttestation,
  type SessionAttestationFields,
  type SessionAttestationExpectation,
} from './identity/sessionAttestation.js'
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
  type CofferdamSpotEscrowClientConfig,
  type TxResult,
  type TxOptions,
  type EscrowState,
  type SpotEscrowPolicy,
  type SpotEscrowState,
} from './escrow/CofferdamSpotEscrowClient.js'

export {
  CofferdamEscrowFactoryClient,
  COFFERDAM_ESCROW_FACTORY_ABI,
  type CofferdamEscrowFactoryClientConfig,
} from './escrow/CofferdamEscrowFactoryClient.js'

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
