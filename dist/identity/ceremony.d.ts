import { type TypedDataDomain, type TypedDataField } from 'ethers';
/** The ceremony domain's `name`. */
export declare const CEREMONY_DOMAIN_NAME = "Cofferdam Ceremony";
/** The ceremony domain's `version`. */
export declare const CEREMONY_DOMAIN_VERSION = "1";
/** The one primary type a ceremony attester signs. */
export declare const CEREMONY_PRIMARY_TYPE = "CeremonyAttestation";
/** The EIP-712 types of a ceremony attestation, in the contract's field order. */
export declare const CEREMONY_TYPES: Readonly<Record<typeof CEREMONY_PRIMARY_TYPE, readonly TypedDataField[]>>;
/** `CeremonyAttestation(address account,bytes32 action,...)`. */
export declare const CEREMONY_TYPE_STRING = "CeremonyAttestation(address account,bytes32 action,bytes32 newKeyHash,bytes32 partnerId,uint256 nonce,uint48 notBefore,uint48 expiry)";
/** `CofferdamAccount4337.CEREMONY_TYPEHASH`. */
export declare const CEREMONY_TYPEHASH: string;
/** The ceremony actions, as `CofferdamAccount4337.ACTION_*` hash them. */
export declare const CEREMONY_ACTIONS: Readonly<{
    'enroll-first-high': string;
    'replace-partner': string;
    'recover-high': string;
}>;
export type CeremonyAction = keyof typeof CEREMONY_ACTIONS;
/** The message a ceremony attester signs. */
export interface CeremonyAttestationMessage {
    /** The `CofferdamAccount4337` the ceremony is for. */
    readonly account: string;
    /** `CEREMONY_ACTIONS[...]`. */
    readonly action: string;
    /** `keccak256(newConfig)` of the authority config the account will store. */
    readonly newKeyHash: string;
    /** The signing Partner authority's `partnerId`, or 32 zero bytes. */
    readonly partnerId: string;
    /** The account's `ceremonyNonce`. */
    readonly nonce: bigint;
    /** Validity window, unix seconds (`uint48`). */
    readonly notBefore: bigint;
    readonly expiry: bigint;
}
/**
 * The ceremony domain for a generation.
 *
 * @param chainId - Base (8453) or Base Sepolia (84532).
 * @param registry - That generation's `CofferdamCeremonyAttesterRegistry`, from the caller's configuration.
 */
export declare function ceremonyDomain(chainId: number | bigint, registry: string): TypedDataDomain;
/** The message with every field checked and normalised; throws on a bad one. */
export declare function checkCeremonyMessage(message: CeremonyAttestationMessage): CeremonyAttestationMessage;
/**
 * The EIP-712 digest of a ceremony attestation: what the attester signs and
 * what `CofferdamAccount4337.ceremonyHash` returns.
 *
 * @returns 0x-prefixed 32 bytes.
 */
export declare function ceremonyDigest(domain: TypedDataDomain, message: CeremonyAttestationMessage): string;
/**
 * Sign a ceremony attestation with a secp256k1 key. Test fixtures and local
 * networks only: the attester signs in its own Worker, so this is not
 * exported from the package's entry point.
 *
 * @internal
 *
 * @returns The 65-byte signature r ‖ s ‖ v (v 27 or 28, low s), 0x hex.
 */
export declare function signCeremonyAttestation(privateKey: Uint8Array, domain: TypedDataDomain, message: CeremonyAttestationMessage): string;
/**
 * The address that signed a ceremony attestation, or null for a malformed
 * signature. The caller compares it with the registry's `isTrustedAttester`;
 * the address alone proves nothing.
 */
export declare function recoverCeremonySigner(domain: TypedDataDomain, message: CeremonyAttestationMessage, signature: string): string | null;
//# sourceMappingURL=ceremony.d.ts.map