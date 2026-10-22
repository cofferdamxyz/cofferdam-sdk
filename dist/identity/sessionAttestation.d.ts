import { type P256PublicKey, type PasskeySigner, type PasskeySignatureScheme } from './passkey.js';
/** Wire-format version of the session-attestation envelope. */
export declare const SESSION_ATTESTATION_VERSION = 1;
/** The `SignInResponse` fields the passkey commits to (everything but the sig). */
export interface SessionAttestationFields {
    /** Consumer-app identifier this session was issued for. */
    scope: string;
    /** Per-app stable pseudonym (the consumer's primary user key). */
    appPseudonym: string;
    /** Base smart-account address governing the session. */
    accountAddress: string;
    /** Chain id (31337 local / 84532 Base Sepolia / 8453 Base mainnet). */
    chainId: number;
    /** Whether the user is Self-verified at issuance. */
    verified: boolean;
    /** Unix epoch milliseconds when the attestation was signed (replay bound). */
    issuedAt: number;
}
/** A full, self-contained session attestation (the decoded `attestation` string). */
export interface SessionAttestation extends SessionAttestationFields {
    v: number;
    /** Signature scheme of `sig` — how a verifier must check it. */
    alg: PasskeySignatureScheme;
    /** The passkey public key that produced `sig`. */
    publicKey: P256PublicKey;
    /**
     * The passkey signature over `sessionAttestationDigest(fields, publicKey)`.
     * Raw 64-byte `r || s` for `alg === 'p256'`; an `abi.encode(WebAuthnAuth)`
     * assertion for `alg === 'webauthn'`.
     */
    sig: string;
}
/** Base class for every session-attestation failure. */
export declare class SessionAttestationError extends Error {
    constructor(message: string);
}
/** The token was not a well-formed Cofferdam session attestation. */
export declare class SessionAttestationDecodeError extends SessionAttestationError {
}
/** The attestation is older than `maxAgeMs` (or clock-skewed into the future). */
export declare class SessionAttestationExpiredError extends SessionAttestationError {
}
/** The signature failed, or a presented field did not match `expect`. */
export declare class SessionAttestationVerificationError extends SessionAttestationError {
}
/**
 * The 32-byte digest the passkey signs (and a verifier recomputes). Commits to a
 * domain separator + every attested field + the signing public key, so tampering
 * any field invalidates the signature (and, for WebAuthn, the challenge match).
 */
export declare function sessionAttestationDigest(f: SessionAttestationFields, publicKey: P256PublicKey): Uint8Array;
/**
 * Build a signed session attestation. Prompts the passkey (the injected `signer`
 * signs the digest — gating on biometric in production). The signer's public key
 * and scheme are recorded in the envelope so the result verifies standalone.
 */
export declare function createSessionAttestation(args: {
    signer: PasskeySigner;
    fields: SessionAttestationFields;
    publicKey?: P256PublicKey;
}): Promise<SessionAttestation>;
/** Serialize an attestation into the compact, prefixed `attestation` token. */
export declare function encodeSessionAttestation(att: SessionAttestation): string;
/** Convenience: `encodeSessionAttestation(await createSessionAttestation(...))`. */
export declare function signSessionAttestation(args: {
    signer: PasskeySigner;
    fields: SessionAttestationFields;
    publicKey?: P256PublicKey;
}): Promise<string>;
/**
 * Parse an `attestation` token into a structurally-valid `SessionAttestation`.
 * Throws `SessionAttestationDecodeError` on any malformation. Does NOT verify the
 * signature — call `verifySessionAttestation` (or `decodeAndVerifySessionAttestation`).
 */
export declare function decodeSessionAttestation(token: string): SessionAttestation;
/** Fields a verifier may pin so a captured attestation cannot be re-pointed. */
export type SessionAttestationExpectation = Partial<Pick<SessionAttestationFields, 'scope' | 'appPseudonym' | 'accountAddress' | 'chainId'>>;
/**
 * Verify a decoded attestation: optional freshness (`maxAgeMs`, 0 to skip) + the
 * optional `expect` field pins + the passkey signature over exactly these fields.
 * Throws on any failure. On success the payload is trustworthy: the holder of
 * `publicKey` signed precisely this `(scope, appPseudonym, accountAddress, …)`.
 *
 * The caller still owns the on-chain authorisation check — confirm `publicKey`
 * is an active authority on `accountAddress` (e.g. via `listAuthorities()`).
 */
export declare function verifySessionAttestation(att: SessionAttestation, opts?: {
    expect?: SessionAttestationExpectation;
    maxAgeMs?: number;
    now?: number;
}): void;
/** Convenience: decode + verify in one call, returning the trusted payload. */
export declare function decodeAndVerifySessionAttestation(token: string, opts?: {
    expect?: SessionAttestationExpectation;
    maxAgeMs?: number;
    now?: number;
}): SessionAttestation;
/** Wire-format version of the device-bound envelope. */
export declare const SESSION_ATTESTATION_V2 = 2;
/** The audience of tokens the Cofferdam plane accepts. */
export declare const CSA_AUDIENCE_PLANE = "cofferdam-plane";
/** Fast: everyday features, minted lazily and reused. Slow: one security-critical action. */
export type SessionTier = 'fast' | 'slow';
/** The longest lifetime a verifier accepts for each tier. */
export declare const SESSION_TIER_MAX_LIFETIME_MS: Readonly<Record<SessionTier, number>>;
/** The fields the passkey commits to in a v2 envelope. */
export interface SessionAttestationV2Fields extends SessionAttestationFields {
    /** Unix epoch milliseconds after which the token is refused. */
    expiresAt: number;
    /** Who may accept the token (`CSA_AUDIENCE_PLANE` for the plane). */
    aud: string;
    /** Which routes the token opens. */
    tier: SessionTier;
    /** RFC 7638 thumbprint of the device key every request must be signed with. */
    jkt: string;
}
/** A decoded v2 envelope. On the wire `jkt` sits under `cnf`. */
export interface SessionAttestationV2 extends Omit<SessionAttestationV2Fields, 'jkt'> {
    v: 2;
    alg: PasskeySignatureScheme;
    publicKey: P256PublicKey;
    cnf: {
        jkt: string;
    };
    sig: string;
}
/** The 32-byte digest the passkey signs for a v2 envelope. */
export declare function sessionAttestationV2Digest(f: SessionAttestationV2Fields, publicKey: P256PublicKey): Uint8Array;
/** Build and sign a v2 envelope. Prompts the passkey (biometric in production). */
export declare function createSessionAttestationV2(args: {
    signer: PasskeySigner;
    fields: SessionAttestationV2Fields;
    publicKey?: P256PublicKey;
}): Promise<SessionAttestationV2>;
/** Serialize a v2 envelope into its `csa1:` token. */
export declare function encodeSessionAttestationV2(att: SessionAttestationV2): string;
/** Convenience: `encodeSessionAttestationV2(await createSessionAttestationV2(...))`. */
export declare function signSessionAttestationV2(args: {
    signer: PasskeySigner;
    fields: SessionAttestationV2Fields;
    publicKey?: P256PublicKey;
}): Promise<string>;
/** The version of a `csa1:` token (1 or 2), without verifying it. */
export declare function sessionAttestationVersion(token: string): number;
/** Parse a v2 token into a structurally valid envelope. Does not verify it. */
export declare function decodeSessionAttestationV2(token: string): SessionAttestationV2;
/**
 * Verify a v2 envelope: lifetime within the tier's cap, not expired, not issued
 * in the future (60 s of skew), the audience, the optional field pins, and the
 * passkey signature. Device possession is checked separately (`verifyPopProof`).
 */
export declare function verifySessionAttestationV2(att: SessionAttestationV2, opts?: {
    audience?: string;
    expect?: SessionAttestationExpectation;
    now?: number;
}): void;
/** Convenience: decode + verify a v2 token, returning the trusted envelope. */
export declare function decodeAndVerifySessionAttestationV2(token: string, opts?: {
    audience?: string;
    expect?: SessionAttestationExpectation;
    now?: number;
}): SessionAttestationV2;
//# sourceMappingURL=sessionAttestation.d.ts.map