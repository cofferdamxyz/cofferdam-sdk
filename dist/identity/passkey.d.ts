/** A P-256 public key as two 0x-prefixed 32-byte hex coordinates. */
export interface P256PublicKey {
    /** Affine x coordinate (`qx`). */
    qx: string;
    /** Affine y coordinate (`qy`). */
    qy: string;
}
/**
 * Discriminates the byte format of a `PasskeySigner.sign()` output so verifiers
 * know how to check it:
 *   - `'p256'`     — a bare 64-byte `r || s` signature (this module's default,
 *                    verified by the on-chain `PasskeyAuthority`).
 *   - `'webauthn'` — an `abi.encode(WebAuthn.WebAuthnAuth)` assertion blob (what
 *                    `WebAuthnPasskeySigner` returns, verified by the on-chain
 *                    `WebAuthnPasskeyAuthority` / off-chain `verifyWebAuthnAssertion`).
 */
export type PasskeySignatureScheme = 'p256' | 'webauthn';
/**
 * The signing seam for the native AA passkey authority. Implementations hold
 * (or gate access to) a P-256 private key and produce raw `r || s` signatures
 * over the account's transaction digest.
 */
export interface PasskeySigner {
    /** The P-256 public key, used to build the on-chain authority `config`. */
    publicKey(): Promise<P256PublicKey>;
    /**
     * Sign a 32-byte `digest`, returning a 0x-prefixed 64-byte `r || s` hex
     * string with low-s normalisation (as `PasskeyAuthority` requires).
     */
    sign(digest: Uint8Array): Promise<string>;
    /**
     * Format of `sign()`'s output, so callers that persist a signature (e.g. the
     * session attestation) can record how to verify it. Absent ⇒ treat as `'p256'`.
     */
    readonly scheme?: PasskeySignatureScheme;
}
/** `abi.encode(bytes32 qx, bytes32 qy)` — the `PasskeyAuthority` config blob. */
export declare function encodePasskeyConfig(pub: P256PublicKey): string;
/** Derive the uncompressed P-256 public key coordinates from a private scalar. */
export declare function p256PublicKey(privateKey: Uint8Array): P256PublicKey;
/**
 * Produce a 64-byte `r || s` P-256 signature over a 32-byte digest, with s
 * forced into the lower half-order. We normalise s explicitly rather than rely
 * on a library default so the output is correct regardless of the bundled
 * `@noble/curves` build (matches contracts/test/helpers/authority.ts).
 */
export declare function signP256Digest(privateKey: Uint8Array, digest: Uint8Array): string;
/**
 * Verify a raw 64-byte `r || s` P-256 signature (as produced by
 * `signP256Digest`) over a 32-byte `digest` against `pub`. The inverse
 * predicate of `signP256Digest`; mirrors the on-chain `PasskeyAuthority` check.
 * Returns false (never throws) on any malformed input.
 */
export declare function verifyP256Digest(pub: P256PublicKey, digest: Uint8Array, signature: string): boolean;
/**
 * Deterministic, software-held P-256 signer. PoC-only: the private key is
 * derived as HMAC-SHA256(seed, userId) so a given (seed, userId) always yields
 * the same passkey — keeping counterfactual addresses and fixtures byte-stable
 * across runs, exactly like `LocalChainProvider`'s deterministic EOA.
 *
 * SECURITY: predictable to anyone who knows `seed` + `userId`. Never use for an
 * account holding real funds; swap in a hardware/WebAuthn `PasskeySigner` for
 * anything beyond local PoC.
 */
export declare class DeterministicPasskeySigner implements PasskeySigner {
    private readonly userId;
    private readonly seed;
    readonly scheme: PasskeySignatureScheme;
    private cached;
    constructor(userId: string, seed?: string);
    private privateKey;
    publicKey(): Promise<P256PublicKey>;
    sign(digest: Uint8Array): Promise<string>;
}
//# sourceMappingURL=passkey.d.ts.map