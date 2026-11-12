/** Version of the derivation scheme below. Frozen once a Vault exists. */
export declare const ROOT_KEYS_VERSION = 1;
/** HKDF salt shared by every root key. Frozen once a Vault exists. */
export declare const ROOT_KEYS_SALT = "cofferdam-root-keys-v1";
/** HKDF labels, one per purpose. Frozen once a Vault exists. */
export declare const ROOT_KEY_LABELS: Readonly<{
    readonly vault: "cofferdam-vault-root-v1";
    readonly messaging: "cofferdam-messaging-root-v1";
    readonly recovery: "cofferdam-recovery-key-v1";
    readonly prfEnvelope: "cofferdam-prf-envelope-v1";
}>;
/**
 * The WebAuthn PRF salt (`extensions.prf.eval.first`) every Cofferdam passkey
 * is asserted with for the PRF envelope: SHA-256 of `cofferdam-prf-salt-v1`,
 * 32 bytes. Frozen once an envelope exists.
 */
export declare const COFFERDAM_PRF_SALT: Uint8Array;
/** Words in the account's phrase: 24 (256 bits of entropy). */
export declare const ROOT_PHRASE_WORDS = 24;
/** The three keys derived from the phrase itself (the PRF key comes from a passkey). */
export interface CofferdamRootKeys {
    /** Key-encryption key of the Vault: wraps each document's, the database's and the contact backup's data key. */
    vault: Uint8Array;
    /** Messaging root key of decision 0039 (rule 7). */
    messaging: Uint8Array;
    /** Recovery key material, index 0 (decision 0080; the curve and the commitment are that decision's). */
    recovery: Uint8Array;
}
/**
 * Whether `phrase` is a valid 24-word BIP-39 English phrase (word list and
 * checksum). A valid 12-word phrase is not the account's root and answers
 * false. Case and spacing between words are normalised as ethers does.
 *
 * @param phrase - The phrase as typed or stored.
 */
export declare function isValidPhrase(phrase: string): boolean;
/**
 * The BIP-39 seed of a 24-word phrase (no passphrase): 64 bytes. The caller
 * zeroes it when done.
 *
 * @param phrase - A 24-word BIP-39 English phrase.
 * @throws when the phrase is not 24 words, holds a word outside the list or
 *   fails its checksum (the message never contains the phrase).
 */
export declare function phraseSeed(phrase: string): Uint8Array;
/**
 * The Vault root key: the key-encryption key that wraps every Vault data key.
 *
 * @param seed - The phrase's 64-byte seed (`phraseSeed`).
 * @returns 32 bytes.
 */
export declare function deriveVaultRootKey(seed: Uint8Array): Uint8Array;
/**
 * The messaging root key of decision 0039 (rule 7).
 *
 * @param seed - The phrase's 64-byte seed (`phraseSeed`).
 * @returns 32 bytes.
 */
export declare function deriveMessagingRootKey(seed: Uint8Array): Uint8Array;
/**
 * Recovery key material for decision 0080's recovery key, one value per index
 * so the key can rotate (label `cofferdam-recovery-key-v1:<index>`). The
 * module yields material only; the curve, the commitment and the rotation
 * rule are decision 0080's.
 *
 * @param seed - The phrase's 64-byte seed (`phraseSeed`).
 * @param index - Rotation index, a non-negative safe integer; 0 first.
 * @returns 32 bytes.
 */
export declare function deriveRecoveryKeyMaterial(seed: Uint8Array, index?: number): Uint8Array;
/**
 * The key that wraps the root keys in a passkey's PRF envelope, from the
 * PRF output (`results.first`) of an assertion evaluated with
 * `COFFERDAM_PRF_SALT`.
 *
 * @param prfFirst - The 32-byte PRF output.
 * @returns 32 bytes.
 */
export declare function derivePrfEnvelopeKey(prfFirst: Uint8Array): Uint8Array;
/**
 * The secret Self binds the passport to, exactly as the app has derived it
 * since the first bind: `HDNodeWallet.fromPhrase(phrase).privateKey`, ethers'
 * default path `m/44'/60'/0'/0/0`. Unchanged on purpose: another path would
 * be a new identity for every bound account. Unlike the root keys it accepts
 * any phrase ethers accepts, as the app always has.
 *
 * @param phrase - The phrase as stored or typed.
 * @returns The `0x`-prefixed 32-byte private key as hex.
 */
export declare function selfSecretFromPhrase(phrase: string): string;
/**
 * The vault, messaging and recovery (index 0) keys of a 24-word phrase in one
 * call; the intermediate seed is zeroed before returning.
 *
 * @param phrase - A 24-word BIP-39 English phrase.
 * @throws as `phraseSeed`.
 */
export declare function deriveRootKeys(phrase: string): CofferdamRootKeys;
//# sourceMappingURL=rootKeys.d.ts.map