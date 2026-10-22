import { type DeviceKeySigner } from './deviceKey.js';
/** How far a proof's `iat` may sit from the verifier's clock, in seconds. */
export declare const POP_MAX_SKEW_S = 60;
/** The JWS `typ` of a proof. */
export declare const POP_TYP = "dpop+jwt";
/** The claims a proof signs. */
export interface PopProofClaims {
    /** The request's HTTP method, upper case. */
    htm: string;
    /** The request URL without query or fragment (`popHtu`). */
    htu: string;
    /** Unix seconds when the proof was made. */
    iat: number;
    /** A random identifier the verifier accepts only once. */
    jti: string;
    /** base64url(SHA-256(token)) of the session attestation it accompanies. */
    ath: string;
}
/** A proof that failed to decode or verify. */
export declare class PopProofError extends Error {
    constructor(message: string);
}
/** The URL a proof names: origin and path, without query or fragment. */
export declare function popHtu(url: string): string;
/** `ath` for a token: base64url(SHA-256(token)). */
export declare function popAth(token: string): string;
/**
 * Make the proof for one request. `htu` may be the full request URL: its query
 * and fragment are dropped. `now` is Unix milliseconds.
 */
export declare function createPopProof(args: {
    deviceKey: DeviceKeySigner;
    htm: string;
    htu: string;
    token: string;
    now?: number;
    jti?: string;
}): Promise<string>;
/**
 * Check a proof against the request and the token it accompanies. Returns the
 * thumbprint of the key that signed it and its `jti`; the caller compares the
 * thumbprint with the token's `cnf.jkt` and records the `jti`.
 */
export declare function verifyPopProof(proof: string, expect: {
    token: string;
    htm: string;
    htu: string;
    now?: number;
    maxSkewS?: number;
}): {
    jkt: string;
    jti: string;
    iat: number;
};
//# sourceMappingURL=popProof.d.ts.map