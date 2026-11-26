// Public API surface for @cofferdam/sdk.
//
// Pre-stable (v0.x); see cofferdam-sdk/README.md §10 — Versioning + release
// policy.
export { Cofferdam } from './Cofferdam.js';
export { MockProvider, SignInRejected, } from './providers/MockProvider.js';
export { LocalChainProvider, } from './providers/LocalChainProvider.js';
export { NativeAccountProvider, PasskeyCapReachedError, MAX_PASSKEYS, L1_LANE_FALLBACK_TIP, L1_PVG_ALLOWANCE, l1LaneGasPrice, } from './providers/NativeAccountProvider.js';
export { USER_OPERATION_PATH, UserOpRelayError, buildInitCode, mayHaveBeenSent, relayUserOperation, serializeUserOperation, } from './providers/userOpRelay.js';
export { ENTRY_POINT_EVENTS_ABI, USER_OPERATION_LOOKBACK_BLOCKS, USER_OPERATION_RECEIPT_TIMEOUT_MS, UserOperationFailedError, confirmUserOperation, findUserOperation, userOperationOutcome, } from './providers/userOpOutcome.js';
export { GAS_PRICE_ORACLE, L1_FEE_MARGIN_BPS, STAND_IN_INNER_SIGNATURE_BYTES, calldataGas, estimateL1PreVerificationGas, preVerificationGasForL1Fee, standInSignature, } from './providers/preVerificationGas.js';
export { COFFERDAM_IDENTITY_REGISTRY_ABI, CofferdamIdentityRegistryClient, IDENTITY_ACTIONS, IDENTITY_ACTION_TAGS, IdentityRegistryError, encodeBindCall, encodeCancelRebindCall, encodeFinalizeRebindCall, encodeRequestRebindCall, encodeZkpEvidence, identityDigest, identityRevertName, rebindRequestedFromLogs, zkpCustomData, zkpEvidenceFromParams, } from './identity/identityRegistry.js';
export { NO_PERMISSION, PERMISSION_TUPLE } from './providers/permission.js';
export { encodeSessionConfig, signSessionInner, deriveSessionSigner, } from './identity/sessionKey.js';
export { DeterministicPasskeySigner, encodePasskeyConfig, p256PublicKey, signP256Digest, verifyP256Digest, } from './identity/passkey.js';
export { WebAuthnPasskeySigner, softwareWebAuthnAuthenticator, softwareWebAuthnPublicKey, p256PublicKeyFromDer, derSignatureToRS, encodeWebAuthnInnerSignature, decodeWebAuthnInnerSignature, verifyWebAuthnAssertion, webAuthnConfig, base64urlToBytes, bytesToBase64url, } from './identity/webauthn.js';
export { createDeviceHandoff, encodeDeviceHandoff, decodeDeviceHandoff, verifyDeviceHandoff, decodeAndVerifyDeviceHandoff, deviceHandoffDigest, DeviceHandoffError, DeviceHandoffDecodeError, DeviceHandoffExpiredError, DeviceHandoffLivenessError, DEVICE_HANDOFF_VERSION, MAX_DEVICE_LABEL_LENGTH, DEFAULT_HANDOFF_MAX_AGE_MS, } from './identity/deviceHandoff.js';
export { mockProfiles, getMockProfile, } from './providers/mockProfiles.js';
export { createSessionAttestation, signSessionAttestation, encodeSessionAttestation, decodeSessionAttestation, verifySessionAttestation, decodeAndVerifySessionAttestation, sessionAttestationDigest, SessionAttestationError, SessionAttestationDecodeError, SessionAttestationExpiredError, SessionAttestationVerificationError, SESSION_ATTESTATION_VERSION, 
// v2: device-bound, tiered, expiring (workspace decision 0055)
SESSION_ATTESTATION_V2, CSA_AUDIENCE_PLANE, SESSION_TIER_MAX_LIFETIME_MS, sessionAttestationV2Digest, createSessionAttestationV2, signSessionAttestationV2, encodeSessionAttestationV2, decodeSessionAttestationV2, verifySessionAttestationV2, decodeAndVerifySessionAttestationV2, sessionAttestationVersion, } from './identity/sessionAttestation.js';
export { jwkThumbprint, p256Jwk, p256FromJwk, randomBase64url, SoftwareDeviceKeySigner, } from './identity/deviceKey.js';
export { createPopProof, verifyPopProof, popHtu, popAth, PopProofError, POP_MAX_SKEW_S, POP_TYP, } from './identity/popProof.js';
export { derivePseudonym, deriveScopeKey } from './identity/pseudonym.js';
export { phraseSeed, isValidPhrase, deriveRootKeys, deriveVaultRootKey, deriveMessagingRootKey, deriveRecoveryKeyMaterial, derivePrfEnvelopeKey, selfSecretFromPhrase, ROOT_KEYS_VERSION, ROOT_KEYS_SALT, ROOT_KEY_LABELS, ROOT_PHRASE_WORDS, COFFERDAM_PRF_SALT, 
// decision 0086: the seed-level handle keys
HANDLE_SEED_LABELS, deriveHandleRoot, deriveTier1KeyMaterial, deriveXmtpRecoveryKeyMaterial, deriveHandleReleaseKeyMaterial, } from './identity/rootKeys.js';
// The ceremony attestation as EIP-712 (workspace decision 0090 item 5)
export { CEREMONY_DOMAIN_NAME, CEREMONY_DOMAIN_VERSION, CEREMONY_PRIMARY_TYPE, CEREMONY_TYPES, CEREMONY_TYPE_STRING, CEREMONY_TYPEHASH, CEREMONY_ACTIONS, ceremonyDomain, ceremonyDigest, checkCeremonyMessage, recoverCeremonySigner, } from './identity/ceremony.js';
// Handles, stealth addresses and handshakes (workspace decision 0086)
export { toHandle, isHandle, handleId, handleAnchorDomain, handleRegistryDomain, handleTypeString, handleTypedDataDigest, signHandleTypedData, recoverHandleTypedDataSigner, HANDLE_MIN_LENGTH, HANDLE_MAX_LENGTH, HANDLE_ID_PREFIX, HANDLE_ANCHOR_DOMAIN_NAME, HANDLE_REGISTRY_DOMAIN_NAME, HANDLE_DOMAIN_VERSION, HANDLE_ANCHOR_TYPES, HANDLE_REGISTRY_TYPES, } from './identity/handle.js';
export { deriveHandleEpochKeys, deriveTier1IdentityKey, deriveXmtpRecoveryIdentity, deriveHandleReleaseKey, deriveSelfEphemeralKey, deriveSelfAddress, walkSelfDerivedAddresses, findHandleEpoch, HANDLE_ROOT_LABELS, SELF_DERIVATION_SLOTS, MAX_SELF_DERIVATION_INDEX, } from './identity/handleRoot.js';
export { encodeMetaAddress, decodeMetaAddress, generateStealthAddress, scanAnnouncement, computeStealthPrivateKey, stealthSignerFromHash, oneTimeAccountAddress, verifyStealthRegistration, secp256k1Address, StealthError, STEALTH_SCHEME_ID, META_ADDRESS_BYTES, } from './identity/stealth.js';
export { createHandshakeHalf, createHandshakeReply, verifyHandshakeHalf, checkHandshakeSigner, handshakeHalfDigest, handshakeDomain, deriveHandshakeSecret, encodeHandshakeHalf, decodeHandshakeHalf, createRenameNotice, verifyRenameNotice, renameNoticeDigest, encodeRenameNotice, decodeRenameNotice, encodeContactRecord, decodeContactRecord, HandshakeError, HANDSHAKE_VERSION, HANDSHAKE_QR_LIFETIME_S, HANDSHAKE_LINK_LIFETIME_S, HANDSHAKE_MAX_SKEW_S, HANDSHAKE_SECRET_SALT, HANDSHAKE_DOMAIN_NAME, HANDSHAKE_TYPES, } from './identity/handshake.js';
export { tierOf, isUntrustedLowTier, chooseEnrollmentLane, evaluateUpgrade, assertCanEnrollFirstPasskey, authorityStateFromResponse, nextMigrationStatus, DEFAULT_DEVICE_CAPABILITY, PasskeyUpgradeError, UpgradePathLockedError, AlreadyHighTierError, ManagedAuthorityNotUpgradableError, PasskeyUpgradeUnsupportedError, } from './identity/authority.js';
export { CofferdamSpotEscrowClient, COFFERDAM_SPOT_ESCROW_ABI, } from './escrow/CofferdamSpotEscrowClient.js';
export { CofferdamEscrowFactoryClient, COFFERDAM_ESCROW_FACTORY_ABI, } from './escrow/CofferdamEscrowFactoryClient.js';
//# sourceMappingURL=index.js.map