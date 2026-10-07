// Public API surface for @cofferdam/sdk.
//
// Pre-stable (v0.x); see cofferdam-sdk/README.md §10 — Versioning + release
// policy.
export { Cofferdam } from './Cofferdam.js';
export { MockProvider, SignInRejected, } from './providers/MockProvider.js';
export { LocalChainProvider, } from './providers/LocalChainProvider.js';
export { NativeAccountProvider, PasskeyCapReachedError, MAX_PASSKEYS, } from './providers/NativeAccountProvider.js';
export { encodeSessionConfig, signSessionInner, deriveSessionSigner, } from './identity/sessionKey.js';
export { DeterministicPasskeySigner, encodePasskeyConfig, p256PublicKey, signP256Digest, verifyP256Digest, } from './identity/passkey.js';
export { WebAuthnPasskeySigner, softwareWebAuthnAuthenticator, softwareWebAuthnPublicKey, p256PublicKeyFromDer, derSignatureToRS, encodeWebAuthnInnerSignature, decodeWebAuthnInnerSignature, verifyWebAuthnAssertion, webAuthnConfig, base64urlToBytes, bytesToBase64url, } from './identity/webauthn.js';
export { createDeviceHandoff, encodeDeviceHandoff, decodeDeviceHandoff, verifyDeviceHandoff, decodeAndVerifyDeviceHandoff, deviceHandoffDigest, DeviceHandoffError, DeviceHandoffDecodeError, DeviceHandoffExpiredError, DeviceHandoffLivenessError, DEVICE_HANDOFF_VERSION, MAX_DEVICE_LABEL_LENGTH, DEFAULT_HANDOFF_MAX_AGE_MS, } from './identity/deviceHandoff.js';
export { mockProfiles, getMockProfile, } from './providers/mockProfiles.js';
export { createSessionAttestation, signSessionAttestation, encodeSessionAttestation, decodeSessionAttestation, verifySessionAttestation, decodeAndVerifySessionAttestation, sessionAttestationDigest, SessionAttestationError, SessionAttestationDecodeError, SessionAttestationExpiredError, SessionAttestationVerificationError, SESSION_ATTESTATION_VERSION, } from './identity/sessionAttestation.js';
export { derivePseudonym, deriveScopeKey } from './identity/pseudonym.js';
export { tierOf, isUntrustedLowTier, chooseEnrollmentLane, evaluateUpgrade, assertCanEnrollFirstPasskey, authorityStateFromResponse, nextMigrationStatus, DEFAULT_DEVICE_CAPABILITY, PasskeyUpgradeError, UpgradePathLockedError, AlreadyHighTierError, ManagedAuthorityNotUpgradableError, PasskeyUpgradeUnsupportedError, } from './identity/authority.js';
export { CofferdamSpotEscrowClient, COFFERDAM_SPOT_ESCROW_ABI, } from './escrow/CofferdamSpotEscrowClient.js';
export { CofferdamEscrowFactoryClient, COFFERDAM_ESCROW_FACTORY_ABI, } from './escrow/CofferdamEscrowFactoryClient.js';
//# sourceMappingURL=index.js.map