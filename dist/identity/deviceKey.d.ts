import type { P256PublicKey } from './passkey.js';
/**
 * The signing seam for a device key. `sign` receives a 32-byte digest and
 * returns a 0x-prefixed 64-byte `r || s` (either half-order of `s` is accepted;
 * `createPopProof` normalises it).
 */
export interface DeviceKeySigner {
    /** The device key's public point. */
    publicKey(): Promise<P256PublicKey>;
    /** Sign a 32-byte digest, returning a 0x-prefixed 64-byte `r || s`. */
    sign(digest: Uint8Array): Promise<string>;
}
/** A P-256 public JWK carrying exactly the members RFC 7638 hashes. */
export interface P256Jwk {
    kty: 'EC';
    crv: 'P-256';
    x: string;
    y: string;
}
/** The public JWK of a P-256 point (base64url coordinates, no padding). */
export declare function p256Jwk(pub: P256PublicKey): P256Jwk;
/** The P-256 point of a public JWK. Throws on anything but a 32-byte-coordinate P-256 key. */
export declare function p256FromJwk(jwk: unknown): P256PublicKey;
/**
 * RFC 7638 thumbprint of a P-256 public key: base64url(SHA-256) of the JWK's
 * required members in lexicographic order with no whitespace. 43 characters.
 */
export declare function jwkThumbprint(pub: P256PublicKey): string;
/**
 * An in-memory device key for tests, servers and tooling. Its private key lives
 * in JavaScript memory, so it is NOT a substitute for the Secure Enclave or the
 * Keystore in an app.
 */
export declare class SoftwareDeviceKeySigner implements DeviceKeySigner {
    #private;
    constructor(privateKey: Uint8Array);
    /** A fresh random key. */
    static generate(): SoftwareDeviceKeySigner;
    publicKey(): Promise<P256PublicKey>;
    sign(digest: Uint8Array): Promise<string>;
}
/** A random base64url identifier of `bytes` bytes (the proof `jti`). */
export declare function randomBase64url(bytes?: number): string;
//# sourceMappingURL=deviceKey.d.ts.map