import { type GeneratedStealthAddress, type OneTimeAccountFactory } from './stealth.js';
/** HKDF labels under the handle root of an epoch. Frozen once a handle is claimed. */
export declare const HANDLE_ROOT_LABELS: Readonly<{
    readonly handleKey: "cofferdam-handle-key-v1";
    readonly stealthSpending: "cofferdam-stealth-spending-v1";
    readonly stealthViewing: "cofferdam-stealth-viewing-v1";
    readonly selfDerivationSeed: "cofferdam-self-derivation-v1";
    /** Followed by the slot as one byte and the index as four big-endian bytes (0086 rule 1). */
    readonly selfEphemeral: "self-ephemeral";
}>;
/** Phone slots of the self-derivation index: 0 to 15 (0086 rule 1). */
export declare const SELF_DERIVATION_SLOTS = 16;
/** Highest self-derivation index: the index is written as four bytes. */
export declare const MAX_SELF_DERIVATION_INDEX = 4294967295;
/** A secp256k1 key with its public forms. */
export interface Secp256k1KeyPair {
    /** 32 bytes. */
    privateKey: Uint8Array;
    /** 33 bytes, compressed. */
    publicKey: Uint8Array;
    /** Checksummed Ethereum address. */
    address: string;
}
/** The keys of one handle epoch. */
export interface HandleEpochKeys {
    epoch: number;
    /** Signs the anchor, registry requests, halves and rename notices; its address is the anchor's `owner`. */
    handleKey: Secp256k1KeyPair;
    /** The stealth spending key. Stays on phrase phones. */
    spendingKey: Secp256k1KeyPair;
    /** The stealth viewing key. */
    viewingKey: Secp256k1KeyPair;
    /** S ‖ V, 66 bytes: the anchor's `metaAddress`. */
    metaAddress: Uint8Array;
    /** The seed of the self-derived ephemeral keys, 32 bytes. */
    selfDerivationSeed: Uint8Array;
}
/**
 * The keys of handle epoch `epoch` (decision 0086 rule 1).
 *
 * @param seed - The phrase's 64-byte seed (`phraseSeed`).
 * @param epoch - The epoch, 0 first.
 */
export declare function deriveHandleEpochKeys(seed: Uint8Array, epoch: number): HandleEpochKeys;
/**
 * The Tier 1 XMTP identity key number `k` (decision 0086 question 12, ruled 2026-11-19):
 * registered with XMTP as a plain key, it signs identity actions only.
 *
 * @param seed - The phrase's 64-byte seed.
 * @param k - The counter, 0 first; it moves only after a theft, an alarm or a phrase rotation.
 */
export declare function deriveTier1IdentityKey(seed: Uint8Array, k?: number): Secp256k1KeyPair;
/**
 * The XMTP recovery identity (decision 0086 rule 1): revokes installations
 * and replaces identity keys. Only the phrase derives it, and no linked phone
 * receives it.
 *
 * @param seed - The phrase's 64-byte seed.
 */
export declare function deriveXmtpRecoveryIdentity(seed: Uint8Array): Secp256k1KeyPair;
/**
 * The release key of a releasing label (decision 0086 question 13, ruled 2026-11-19): a
 * phrase phone moves the old record to it when the anchor watch sees a
 * cancelled release or a queued change it did not make.
 *
 * @param seed - The phrase's 64-byte seed (the new phrase's after a rotation).
 * @param handleId - The releasing label's 32-byte `handleId`.
 */
export declare function deriveHandleReleaseKey(seed: Uint8Array, handleId: Uint8Array): Secp256k1KeyPair;
/**
 * The ephemeral private key r of the self-derived address (p, i) (decision
 * 0086 rule 1): addresses the user's own phones derive (an escrow's receive
 * address, a funding address), found again by index without the plane.
 *
 * @param selfDerivationSeed - The epoch's self-derivation seed.
 * @param slot - The phone's slot p, 0 to 15, from 0082's synced device list.
 * @param index - i, 0 to 2^32 - 1.
 * @returns 32 bytes.
 */
export declare function deriveSelfEphemeralKey(selfDerivationSeed: Uint8Array, slot: number, index: number): Uint8Array;
/** A self-derived one-time address. */
export interface SelfDerivedAddress extends GeneratedStealthAddress {
    slot: number;
    index: number;
}
/**
 * The self-derived one-time address (p, i) of a meta-address: the stealth
 * derivation with r(p, i) as the ephemeral key. A linked phone, which holds
 * no spending key, derives it from the public meta-address.
 *
 * @param input - The epoch's self seed and meta-address, the factory, the slot and the index.
 */
export declare function deriveSelfAddress(input: {
    selfDerivationSeed: Uint8Array;
    metaAddress: Uint8Array | string;
    factory: OneTimeAccountFactory;
    slot: number;
    index: number;
}): SelfDerivedAddress;
/**
 * Recovery's walk of the self-derived addresses (decision 0086 rule 1): every
 * slot from index 0 until `gapLimit` unused indexes in a row.
 *
 * @param input.isUsed - Whether an account has ever been used (a balance, a
 *   transfer, an escrow naming it); the caller reads the chain or the feed.
 * @param input.gapLimit - Unused indexes in a row that end a slot; 20 by default.
 * @param input.slots - The slots to walk; all 16 by default.
 * @returns Every used address, slot by slot, index by index.
 */
export declare function walkSelfDerivedAddresses(input: {
    selfDerivationSeed: Uint8Array;
    metaAddress: Uint8Array | string;
    factory: OneTimeAccountFactory;
    isUsed: (account: string) => boolean | Promise<boolean>;
    gapLimit?: number | undefined;
    slots?: readonly number[] | undefined;
}): Promise<SelfDerivedAddress[]>;
/**
 * Recovery's epoch search (decision 0086 rule 1): the first epoch whose handle
 * key's address is the anchor's `owner`, or null within `maxEpochs`.
 *
 * @param seed - The phrase's 64-byte seed (each legacy phrase is searched with its own).
 * @param owner - The anchor record's `owner`.
 * @param maxEpochs - Epochs to try, from 0; 64 by default.
 */
export declare function findHandleEpoch(seed: Uint8Array, owner: string, maxEpochs?: number): number | null;
//# sourceMappingURL=handleRoot.d.ts.map