/** ERC-5564 scheme id of secp256k1 with view tags, the only scheme Cofferdam uses. */
export declare const STEALTH_SCHEME_ID = 1;
/** Bytes in a scheme 1 meta-address: the spending then the viewing public key, compressed. */
export declare const META_ADDRESS_BYTES = 66;
/** A stealth operation refused (a malformed key, or a hash outside the curve order). */
export declare class StealthError extends Error {
    constructor(message: string);
}
/** The two public keys of a scheme 1 meta-address. */
export interface StealthMetaAddress {
    /** S, 33 bytes compressed. */
    spendingPublicKey: Uint8Array;
    /** V, 33 bytes compressed. */
    viewingPublicKey: Uint8Array;
}
/**
 * How a one-time account's address follows from its signer: a CREATE2
 * factory and the hash of the init code, with the signer left-padded to 32
 * bytes as the salt.
 */
export interface OneTimeAccountFactory {
    /** The factory's address. */
    address: string;
    /** keccak256 of the account's init code, 0x-prefixed 32 bytes. */
    initCodeHash: string;
}
/**
 * The address of a secp256k1 private key, checksummed.
 *
 * @param privateKey - 32 bytes, 0 < k < n.
 */
export declare function secp256k1Address(privateKey: Uint8Array): string;
/**
 * The scalar a 32-byte HKDF output gives: the value reduced mod the curve
 * order, 0 refused (decision 0086 rule 1).
 *
 * @param material - 32 bytes of key material.
 * @returns A valid 32-byte secp256k1 private key.
 */
export declare function secp256k1KeyFromMaterial(material: Uint8Array): Uint8Array;
/**
 * The 66-byte scheme 1 meta-address of two compressed public keys.
 *
 * @param spendingPublicKey - S, 33 bytes.
 * @param viewingPublicKey - V, 33 bytes.
 */
export declare function encodeMetaAddress(spendingPublicKey: Uint8Array, viewingPublicKey: Uint8Array): Uint8Array;
/**
 * The two keys of a scheme 1 meta-address, each checked to be on the curve.
 *
 * @param metaAddress - 66 bytes, or their 0x-prefixed hex.
 * @throws StealthError when the length or either point is wrong.
 */
export declare function decodeMetaAddress(metaAddress: Uint8Array | string): StealthMetaAddress;
/**
 * The stealth signer P = S + h·G for a spending key and a shared-secret hash:
 * what the plane's `addresses` route checks (0086 rule 5), with no ephemeral
 * secret and no viewing key.
 *
 * @param spendingPublicKey - S, 33 bytes.
 * @param sharedSecretHash - h, 32 bytes.
 * @returns The signer's checksummed address.
 */
export declare function stealthSignerFromHash(spendingPublicKey: Uint8Array, sharedSecretHash: Uint8Array): string;
/**
 * The one-time account a factory gives a stealth signer (CREATE2, the signer
 * left-padded to 32 bytes as the salt). The address an announcement names.
 *
 * @param signer - The stealth signer's address.
 * @param factory - The factory, from the caller's configuration (decision 0083 rule 4).
 * @returns The account's checksummed address.
 */
export declare function oneTimeAccountAddress(signer: string, factory: OneTimeAccountFactory): string;
/** A one-time address derived for a payment, and what its announcement carries. */
export interface GeneratedStealthAddress {
    /** The one-time account (`oneTimeAccountAddress` of the signer): the announcement's `stealthAddress`. */
    account: string;
    /** The stealth signer P = S + h·G. */
    signer: string;
    /** R = r·G, 33 bytes compressed. */
    ephemeralPublicKey: Uint8Array;
    /** h[0], the first byte of the announcement's metadata. */
    viewTag: number;
    /** h, 32 bytes: per address, kept encrypted by the plane when registered (0083 R10). */
    sharedSecretHash: Uint8Array;
}
/**
 * Derive a one-time address from a meta-address (the payer's side, or the
 * user's own phone with a self-derived ephemeral key).
 *
 * @param metaAddress - The 66-byte meta-address, checked against the anchor first.
 * @param factory - The one-time account factory.
 * @param ephemeralPrivateKey - r, 32 bytes; a fresh random one when omitted.
 *   The caller drops it once the payment is built.
 * @throws StealthError on a malformed meta-address or key, and in the
 *   2^-128 case where h falls outside the curve order (pick another r).
 */
export declare function generateStealthAddress(metaAddress: Uint8Array | string, factory: OneTimeAccountFactory, ephemeralPrivateKey?: Uint8Array): GeneratedStealthAddress;
/** What an ERC-5564 announcement carries that a scan reads. */
export interface StealthAnnouncement {
    /** The announced address: the one-time account, not its signer (0086 rule 5). */
    stealthAddress: string;
    /** R, 33 bytes compressed. */
    ephemeralPublicKey: Uint8Array;
    /** The first byte of the announcement's metadata. */
    viewTag: number;
}
/** An announcement a scan found to be the user's. */
export interface StealthMatch {
    /** The one-time account. */
    account: string;
    /** Its stealth signer. */
    signer: string;
    /** h, which the `addresses` route's registration carries (0086 question 18, ruled 2026-11-19). */
    sharedSecretHash: Uint8Array;
}
/**
 * Scan one announcement with a viewing key: null unless it pays this
 * meta-address. The view tag is compared first, so most foreign
 * announcements cost one curve multiplication.
 *
 * @param announcement - The announcement's account, R and view tag.
 * @param keys - The viewing private key, the spending public key of the same
 *   meta-address, and the one-time account factory.
 */
export declare function scanAnnouncement(announcement: StealthAnnouncement, keys: {
    viewingPrivateKey: Uint8Array;
    spendingPublicKey: Uint8Array;
    factory: OneTimeAccountFactory;
}): StealthMatch | null;
/**
 * The private key of a one-time address's signer: p = s_spend + h (mod n).
 * Only a phone holding the spending key (a phrase phone) can call it.
 *
 * @param spendingPrivateKey - s_spend, 32 bytes.
 * @param viewingPrivateKey - v, 32 bytes.
 * @param ephemeralPublicKey - R from the announcement, 33 bytes.
 * @returns The stealth private key and its address, and h.
 */
export declare function computeStealthPrivateKey(spendingPrivateKey: Uint8Array, viewingPrivateKey: Uint8Array, ephemeralPublicKey: Uint8Array): {
    privateKey: Uint8Array;
    signer: string;
    sharedSecretHash: Uint8Array;
};
/**
 * The plane's check of an `addresses` registration (0086 rule 5 and question 18):
 * the account is the factory's for P = S + h·G, with S the spending key of
 * the meta-address the registration names, and the view tag is h[0]. The
 * handle key's signature over the registration is checked separately
 * (`RegisterAddress` in `handle.ts`), as is whether the meta-address is one
 * the identity's handles have had.
 *
 * @returns Whether the account is the meta-address's for h.
 */
export declare function verifyStealthRegistration(registration: {
    account: string;
    metaAddress: Uint8Array | string;
    sharedSecretHash: Uint8Array;
    viewTag?: number | undefined;
    factory: OneTimeAccountFactory;
}): boolean;
//# sourceMappingURL=stealth.d.ts.map