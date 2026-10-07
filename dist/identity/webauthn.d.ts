import { type P256PublicKey, type PasskeySigner, type PasskeySignatureScheme } from './passkey.js';
/** A single WebAuthn assertion, as returned by a platform authenticator. Each
 *  field may be a base64url string (the raw `react-native-passkeys` / browser
 *  shape) or already-decoded bytes; `clientDataJSON` may also be the raw JSON. */
export interface WebAuthnAssertion {
    /** `response.authenticatorData` — base64url string or bytes. */
    authenticatorData: string | Uint8Array;
    /** `response.clientDataJSON` — base64url string, raw JSON string, or bytes. */
    clientDataJSON: string | Uint8Array;
    /** `response.signature` — ASN.1 DER ECDSA, base64url string or bytes. */
    signature: string | Uint8Array;
}
/**
 * The injected ceremony seam. An implementation performs a WebAuthn assertion
 * (`get`) over `challenge` (the 32-byte tx digest) and returns the response.
 * The browser/native adapter is responsible for selecting the right credential
 * and prompting the user (biometric).
 */
export interface WebAuthnAuthenticator {
    authenticate(challenge: Uint8Array): Promise<WebAuthnAssertion>;
}
/** Decode a base64url (or base64) string to bytes. Portable: no atob/Buffer. */
export declare function base64urlToBytes(input: string): Uint8Array;
/** Encode bytes to base64url (no padding). Portable. */
export declare function bytesToBase64url(bytes: Uint8Array): string;
/**
 * Recover `{qx, qy}` from a DER-encoded SubjectPublicKeyInfo (the
 * `response.publicKey` a platform returns at registration for an ES256 key).
 * For P-256 the uncompressed point `0x04 || X(32) || Y(32)` is the trailing 65
 * bytes of the SPKI; we extract and validate it on-curve via @noble.
 */
export declare function p256PublicKeyFromDer(der: string | Uint8Array): P256PublicKey;
/** Parse an ASN.1 DER ECDSA signature into low-s-normalised 32-byte r and s. */
export declare function derSignatureToRS(der: string | Uint8Array): {
    r: string;
    s: string;
};
/**
 * Encode a WebAuthn assertion into the `abi.encode(WebAuthn.WebAuthnAuth)` blob
 * the on-chain authority decodes. Computes `typeIndex` / `challengeIndex` from
 * the clientDataJSON and DER-decodes the signature to low-s r/s.
 */
export declare function encodeWebAuthnInnerSignature(assertion: WebAuthnAssertion): string;
/** A decoded `WebAuthn.WebAuthnAuth` blob (the inverse of `encodeWebAuthnInnerSignature`). */
export interface DecodedWebAuthnAuth {
    r: string;
    s: string;
    challengeIndex: number;
    typeIndex: number;
    authenticatorData: Uint8Array;
    clientDataJSON: string;
}
/** Decode an `abi.encode(WebAuthn.WebAuthnAuth)` blob back into its fields. */
export declare function decodeWebAuthnInnerSignature(blob: string): DecodedWebAuthnAuth;
/**
 * Off-chain mirror of the on-chain `WebAuthnPasskeyAuthority` check: verify that
 * `blob` is a WebAuthn assertion by `pub` over `expectedChallenge` (the 32-byte
 * digest). Confirms `type == "webauthn.get"`, the embedded `challenge` equals
 * `base64url(expectedChallenge)`, and the P-256 signature over
 * `sha256(authenticatorData || sha256(clientDataJSON))` validates against `pub`.
 * Returns false (never throws) on any malformed input or mismatch.
 */
export declare function verifyWebAuthnAssertion(blob: string, expectedChallenge: Uint8Array, pub: P256PublicKey): boolean;
/**
 * A `PasskeySigner` backed by a real WebAuthn authenticator. The public key is
 * captured once at enrolment (`p256PublicKeyFromDer(create().response.publicKey)`)
 * and stored as the account's authority config; `sign()` performs an assertion
 * over the tx digest and returns the `WebAuthnAuth` blob the
 * `WebAuthnPasskeyAuthority` expects as `innerSignature`.
 *
 * Note the returned `sign()` value is NOT a bare 64-byte r||s (as in the
 * software `DeterministicPasskeySigner`) — it is the full ABI-encoded assertion.
 * `NativeAccountProvider` is agnostic: it wraps whatever bytes the signer
 * returns as `abi.encode(authorityId, innerSignature)`.
 */
export declare class WebAuthnPasskeySigner implements PasskeySigner {
    private readonly pubKey;
    private readonly authenticator;
    readonly scheme: PasskeySignatureScheme;
    constructor(pubKey: P256PublicKey, authenticator: WebAuthnAuthenticator);
    publicKey(): Promise<P256PublicKey>;
    sign(digest: Uint8Array): Promise<string>;
}
/** Convenience: the account authority config for a WebAuthn pubkey. */
export declare function webAuthnConfig(pub: P256PublicKey): string;
/**
 * A software `WebAuthnAuthenticator` that synthesises a valid assertion with a
 * held P-256 key — byte-identical to what a hardware authenticator emits, and
 * to contracts/test/helpers/authority.ts `signWebAuthn`. For tests and local
 * PoC only: there is no biometric gate and the key is in memory.
 *
 * `flags` defaults to UP|UV|BE|BS (0x1d): a synced platform passkey that did UV.
 */
export declare function softwareWebAuthnAuthenticator(privateKey: Uint8Array, opts?: {
    rpId?: string;
    origin?: string;
    flags?: number;
}): WebAuthnAuthenticator;
/** Derive `{qx, qy}` directly from a P-256 private scalar (software-key helper). */
export declare function softwareWebAuthnPublicKey(privateKey: Uint8Array): P256PublicKey;
//# sourceMappingURL=webauthn.d.ts.map