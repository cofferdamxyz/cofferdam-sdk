import { type TypedDataDomain, type TypedDataField } from 'ethers';
/** Shortest handle (0086 question 9). */
export declare const HANDLE_MIN_LENGTH = 3;
/** Longest handle. */
export declare const HANDLE_MAX_LENGTH = 64;
/**
 * The handle in its one stored form (the label, without `@`), or null when
 * the input is no handle. A leading `@` and surrounding space are dropped and
 * the rest normalised with ENSIP-15 (`Ana` → `ana`, full-width letters
 * folded), then held to the label rules.
 *
 * @param input - What the user typed or a peer sent.
 */
export declare function toHandle(input: string | null | undefined): string | null;
/**
 * Whether `handle` is already in its stored form: what the registry keeps
 * and what `handleId` takes.
 */
export declare function isHandle(handle: string | null | undefined): boolean;
/** The domain prefix of `handleId` (0086 rule 2). Frozen. */
export declare const HANDLE_ID_PREFIX = "cofferdam-handle-v1:";
/**
 * The anchor's key for a label (0086 rule 2): keccak256 of
 * `cofferdam-handle-v1:` and the label's UTF-8 bytes. It names no parent.
 *
 * @param label - A handle in its stored form (`isHandle`).
 * @returns 0x-prefixed 32 bytes.
 * @throws when the label is not in its stored form.
 */
export declare function handleId(label: string): string;
/** Name of the anchor's EIP-712 domain. */
export declare const HANDLE_ANCHOR_DOMAIN_NAME = "CofferdamHandleAnchor";
/** Name of the registry's EIP-712 domain. */
export declare const HANDLE_REGISTRY_DOMAIN_NAME = "CofferdamHandleRegistry";
/** Version of both domains. */
export declare const HANDLE_DOMAIN_VERSION = "1";
/**
 * The anchor's EIP-712 domain.
 *
 * @param chainId - Base (8453) or Base Sepolia (84532).
 * @param verifyingContract - The `CofferdamHandleAnchor` address, from the caller's configuration.
 */
export declare function handleAnchorDomain(chainId: number, verifyingContract: string): TypedDataDomain;
/**
 * The registry's EIP-712 domain: no contract, the chain of the anchor the
 * plane relays to.
 *
 * @param chainId - Base (8453) or Base Sepolia (84532).
 */
export declare function handleRegistryDomain(chainId: number): TypedDataDomain;
/**
 * Every signed call of `CofferdamHandleAnchor` (0086 rule 3), by primary type.
 * Each type is flat (no nested structs). Who signs each:
 * - `RegistrarClaim`: a registrar; `OwnerClaim`: the claiming handle key.
 * - `TransferOwner`, `SetMetaAddress`, `Release`, `Cancel`: the owner, taking
 *   effect after 72 hours (`Cancel` at once); `TransferOwnerAccept`: the new key.
 * - `RegistrarTransferOwner`, `RegistrarSetMetaAddress`, `RegistrarCancel`: a
 *   registrar, on `advance`'s terms (a High ceremony and the pinned locator,
 *   question 19). Only `Release` takes the owner alone, so the handle key of
 *   a removed or stolen linked phone can neither move the record nor keep
 *   raising its nonce (the review of 2026-11-19, H1 and M1).
 * - `Advance`: the owner; `AdvanceAccept`: the new key; `RegistrarAdvance`: a
 *   registrar, after a High ceremony. Immediate.
 * - `Hold`, `RenewHold`, `Veto`: a registrar, after a High ceremony.
 * - `Unfreeze`: the owner; `RegistrarUnfreeze`: a registrar (question 15, ruled 2026-11-19).
 */
export declare const HANDLE_ANCHOR_TYPES: Readonly<{
    RegistrarClaim: TypedDataField[];
    OwnerClaim: TypedDataField[];
    TransferOwner: TypedDataField[];
    TransferOwnerAccept: TypedDataField[];
    RegistrarTransferOwner: TypedDataField[];
    SetMetaAddress: TypedDataField[];
    RegistrarSetMetaAddress: TypedDataField[];
    Release: TypedDataField[];
    Cancel: TypedDataField[];
    RegistrarCancel: TypedDataField[];
    Advance: TypedDataField[];
    AdvanceAccept: TypedDataField[];
    RegistrarAdvance: TypedDataField[];
    Hold: TypedDataField[];
    RenewHold: TypedDataField[];
    Veto: TypedDataField[];
    Unfreeze: TypedDataField[];
    RegistrarUnfreeze: TypedDataField[];
}>;
/**
 * The registry's handle-scoped requests (0086 rules 4 to 7), signed by the
 * handle key:
 * - `RegistryClaim`: `POST /v1/handles/claim`, by the claiming key;
 * - `SetDiscoverable`: "Let people find me" on or off, with the Tier 1 inbox
 *   id only while on (empty when off);
 * - `RenameHandle`: by the old key, naming the new label and the next epoch's keys;
 * - `ReleaseHandle`: give the label up;
 * - `RegisterAddress`: the `addresses` route (named `self` until 2026-11-19), an address the user's phone derived
 *   or found by a scan, with R, h and the meta-address it derives from.
 */
export declare const HANDLE_REGISTRY_TYPES: Readonly<{
    RegistryClaim: TypedDataField[];
    SetDiscoverable: TypedDataField[];
    RenameHandle: TypedDataField[];
    ReleaseHandle: TypedDataField[];
    RegisterAddress: TypedDataField[];
}>;
/** A primary type of the anchor. */
export type HandleAnchorPrimaryType = keyof typeof HANDLE_ANCHOR_TYPES;
/** A primary type of the registry. */
export type HandleRegistryPrimaryType = keyof typeof HANDLE_REGISTRY_TYPES;
/** A primary type of either domain. */
export type HandlePrimaryType = HandleAnchorPrimaryType | HandleRegistryPrimaryType;
/** A message: one value per field of its type (bigint or number for uints, 0x hex for bytes). */
export type HandleTypedMessage = Record<string, unknown>;
/**
 * The canonical EIP-712 type string of a primary type, e.g.
 * `Release(bytes32 handleId,uint256 nonce,uint64 deadline)`.
 */
export declare function handleTypeString(primaryType: HandlePrimaryType): string;
/**
 * The EIP-712 digest of a handle message: what a key signs.
 *
 * @param domain - `handleAnchorDomain` or `handleRegistryDomain`, matching the type.
 * @param primaryType - One of `HANDLE_ANCHOR_TYPES` or `HANDLE_REGISTRY_TYPES`.
 * @param message - Exactly the type's fields.
 * @returns 0x-prefixed 32 bytes.
 */
export declare function handleTypedDataDigest(domain: TypedDataDomain, primaryType: HandlePrimaryType, message: HandleTypedMessage): string;
/**
 * Sign a handle message with a secp256k1 key (the handle key, a release key,
 * or a registrar's key in the plane's tests).
 *
 * @returns The 65-byte signature r ‖ s ‖ v (v 27 or 28, low s), 0x hex.
 */
export declare function signHandleTypedData(privateKey: Uint8Array, domain: TypedDataDomain, primaryType: HandlePrimaryType, message: HandleTypedMessage): string;
/**
 * The address that signed a handle message, or null for a malformed
 * signature. The caller compares it with the anchor's `owner` (or a
 * registrar); the address alone proves nothing.
 */
export declare function recoverHandleTypedDataSigner(domain: TypedDataDomain, primaryType: HandlePrimaryType, message: HandleTypedMessage, signature: string): string | null;
//# sourceMappingURL=handle.d.ts.map