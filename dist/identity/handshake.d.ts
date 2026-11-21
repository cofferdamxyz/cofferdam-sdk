import { type TypedDataDomain, type TypedDataField } from 'ethers';
/** Version of the half, the notice and the contact record. */
export declare const HANDSHAKE_VERSION = 1;
/** Lifetime of a half shown as a QR code: 10 minutes (0086 rule 8). */
export declare const HANDSHAKE_QR_LIFETIME_S: number;
/** Lifetime of a half on a share link or an introduction card: 7 days (0086 rule 8). */
export declare const HANDSHAKE_LINK_LIFETIME_S: number;
/** Clock skew tolerated on an expiry: 5 minutes. */
export declare const HANDSHAKE_MAX_SKEW_S: number;
/** HKDF salt of the pairwise secret (0086 rule 8). Frozen. */
export declare const HANDSHAKE_SECRET_SALT = "cofferdam-handshake-v1";
/** Name of the handshake's EIP-712 domain. */
export declare const HANDSHAKE_DOMAIN_NAME = "CofferdamHandshake";
/** A handshake refused, with the reason as a code. */
export declare class HandshakeError extends Error {
    readonly code: 'malformed' | 'bad-signature' | 'expired' | 'lifetime' | 'replayed' | 'owner-mismatch' | 'serial-mismatch' | 'frozen' | 'pending-change' | 'wrong-peer' | 'wrong-reply';
    constructor(code: 'malformed' | 'bad-signature' | 'expired' | 'lifetime' | 'replayed' | 'owner-mismatch' | 'serial-mismatch' | 'frozen' | 'pending-change' | 'wrong-peer' | 'wrong-reply', message: string);
}
/**
 * The handshake's EIP-712 domain.
 *
 * @param chainId - The chain of the anchor the halves are checked against.
 */
export declare function handshakeDomain(chainId: number): TypedDataDomain;
/** The EIP-712 types of the half and the rename notice. */
export declare const HANDSHAKE_TYPES: Readonly<{
    HandshakeHalf: TypedDataField[];
    RenameNotice: TypedDataField[];
}>;
/** One signed half (0086 rule 8). Hex fields are 0x-prefixed lowercase. */
export interface HandshakeHalf {
    v: 1;
    /** The sender's handle, stored form. */
    handle: string;
    handleId: string;
    serial: number;
    /** The sender's Tier 1 XMTP inbox id. */
    inboxId: string;
    /** The X25519 public key, 32 bytes. */
    ephemeralKey: string;
    /** 32 random bytes. */
    nonce: string;
    /** Unix seconds. */
    expiresAt: number;
    /** The intended peer's handle, or null when not known. */
    peerHandle: string | null;
    /** Digest of the half this one answers; null on a first half. */
    replyTo: string | null;
    /** The handle key's 65-byte signature. */
    signature: string;
}
/**
 * The EIP-712 digest of a half: what the handle key signs, what a reply's
 * `replyTo` names, and what the pairwise secret's info binds.
 */
export declare function handshakeHalfDigest(half: HandshakeHalf, chainId: number): string;
/** What a new half needs. */
export interface CreateHandshakeHalfInput {
    /** The current epoch's handle key, 32 bytes. */
    handleKey: Uint8Array;
    handle: string;
    serial: number;
    inboxId: string;
    chainId: number;
    /** `qr` (10 minutes) or `link` (7 days, also an introduction card). */
    carrier: 'qr' | 'link';
    peerHandle?: string | null | undefined;
    /** Milliseconds; `Date.now()` by default. */
    now?: number | undefined;
}
/**
 * Make a first half. The returned ephemeral private key stays on the phone
 * until the handshake completes or expires, then the caller deletes it.
 */
export declare function createHandshakeHalf(input: CreateHandshakeHalfInput): {
    half: HandshakeHalf;
    ephemeralPrivateKey: Uint8Array;
};
/**
 * Make the reply to a half that `verifyHandshakeHalf` accepted: it names the
 * first half's sender as the peer and its digest as `replyTo`.
 */
export declare function createHandshakeReply(first: HandshakeHalf, input: Omit<CreateHandshakeHalfInput, 'peerHandle'>): {
    half: HandshakeHalf;
    ephemeralPrivateKey: Uint8Array;
};
/** The anchor record a half is checked against, as the client read it from Base. */
export interface HandshakeAnchorView {
    owner: string;
    serial: number;
    /** `frozenUntil` is in the future. */
    frozen: boolean;
    /** A change is pending. */
    pendingChange: boolean;
}
/** What a check of a half found. */
export interface HandshakeHalfCheck {
    /** `checked` against the anchor; `unchecked` when no anchor was given (scanned offline). */
    status: 'checked' | 'unchecked';
    /** The address that signed it; compare with the anchor's `owner` once online. */
    signer: string;
    digest: string;
}
/**
 * Check a half (0086 rule 8): well-formed, signed, not expired, not
 * replayed, for this peer, and, with an anchor, signed by its `owner` at the
 * same `serial` on a record neither frozen nor with a pending change.
 * Without an anchor the half is `unchecked`, and the caller checks it again
 * with `checkHandshakeSigner` when the phone is next online.
 *
 * @param opts.isReplay - Required: whether this nonce was seen before; the caller
 *   records it once the half is accepted.
 * @param opts.selfHandle - The verifier's own handle: a half naming another peer is refused.
 * @param opts.inReplyTo - For a reply, the first half it must answer (itself no reply). A reply
 *   checked without it is refused (`wrong-reply`): it is never taken for a new first half.
 * @throws HandshakeError
 */
export declare function verifyHandshakeHalf(half: HandshakeHalf, opts: {
    chainId: number;
    now?: number | undefined;
    anchor?: HandshakeAnchorView | null | undefined;
    isReplay: (nonce: string) => boolean;
    selfHandle?: string | undefined;
    inReplyTo?: HandshakeHalf | undefined;
    /** The carrier it arrived by: a `qr` half may live 10 minutes at most. */
    carrier?: 'qr' | 'link' | undefined;
}): HandshakeHalfCheck;
/**
 * The anchor half of the check: the signer is the record's `owner`, at the
 * half's `serial`, and the record is neither frozen nor has a pending change.
 * For a half kept `unchecked`, run it when the phone is next online.
 *
 * @throws HandshakeError
 */
export declare function checkHandshakeSigner(half: HandshakeHalf, signer: string, anchor: HandshakeAnchorView): void;
/**
 * The pairwise secret of a completed handshake (0086 rule 8), the same on
 * both phones. It keys the filter given to that contact and authenticates
 * the first XMTP message (decision 0039).
 *
 * @param input.ephemeralPrivateKey - This phone's X25519 key for this handshake.
 * @param input.first - The first half.
 * @param input.reply - The reply half (`replyTo` = the first's digest).
 * @returns 32 bytes.
 */
export declare function deriveHandshakeSecret(input: {
    ephemeralPrivateKey: Uint8Array;
    first: HandshakeHalf;
    reply: HandshakeHalf;
    chainId: number;
}): Uint8Array;
/**
 * A rename notice sent to each contact over XMTP: old `handleId` → new
 * `handleId`, signed by both handle keys, carrying the plane's same-identity
 * statement. Whether a contact follows it (the anchor conditions of rule 7,
 * question 23) is the app's check.
 */
export interface RenameNotice {
    v: 1;
    oldHandle: string;
    oldHandleId: string;
    oldSerial: number;
    oldOwner: string;
    newHandle: string;
    newHandleId: string;
    newSerial: number;
    newOwner: string;
    /** Unix seconds. */
    issuedAt: number;
    oldSignature: string;
    newSignature: string;
    /**
     * The plane's signed statement that both handles belong to one identity, as the plane encodes it; carried, never
     * published. The handle keys' signatures do not cover it, so the plane's statement must name both handleIds and
     * the app must check that it does (runbook step 3).
     */
    identityStatement: string;
}
/** The EIP-712 digest both handle keys sign. */
export declare function renameNoticeDigest(notice: RenameNotice, chainId: number): string;
/** Make a rename notice signed by the old and the new handle keys. */
export declare function createRenameNotice(input: {
    oldHandleKey: Uint8Array;
    newHandleKey: Uint8Array;
    oldHandle: string;
    oldSerial: number;
    newHandle: string;
    newSerial: number;
    identityStatement: string;
    chainId: number;
    now?: number | undefined;
}): RenameNotice;
/**
 * Check a rename notice's own consistency: both handle ids match their
 * handles, and the old and new keys both signed it. The caller then checks
 * `oldOwner` and `newOwner` against the anchor and the identity statement
 * against the plane's key (rule 7).
 *
 * @throws HandshakeError
 */
export declare function verifyRenameNotice(notice: RenameNotice, chainId: number): void;
/** How a contact was made (0039's table, 0086 rule 8). */
export type ContactPath = 'in-person' | 'share-link' | 'job-award' | 'introduction' | 'find-me';
/**
 * A contact as the Vault's `contacts` table keeps it (0086 rule 8). It holds
 * no address: a payment resolves the handle each time.
 */
export interface ContactRecord {
    v: 1;
    handle: string;
    handleId: string;
    serial: number;
    /** The anchor's `owner` at the handshake. */
    ownerAtHandshake: string;
    inboxId: string;
    /** The pairwise secret, 32 bytes. */
    pairwiseSecret: Uint8Array;
    path: ContactPath;
    /** The two signed halves. */
    receipt: {
        first: HandshakeHalf;
        reply: HandshakeHalf;
    };
    /** The filter the peer gave, or null before it arrives. */
    filterReceived: Uint8Array | null;
    /** The name the peer chose to send, or null. */
    name: string | null;
    /** The avatar the peer chose to send (a reference the app resolves), or null. */
    avatar: string | null;
    sharesContacts: boolean;
    /** Milliseconds since the epoch. */
    createdAt: number;
}
/**
 * Encode a contact record as UTF-8 JSON with hex bytes, ready for the Vault
 * store (which encrypts it).
 *
 * @throws HandshakeError('malformed') for a record `decodeContactRecord` would refuse.
 */
export declare function encodeContactRecord(record: ContactRecord): Uint8Array;
/**
 * Decode a contact record, refusing unknown fields, a wrong type anywhere and
 * any field that could hold an address beyond the owner at handshake.
 *
 * @throws HandshakeError('malformed')
 */
export declare function decodeContactRecord(bytes: Uint8Array): ContactRecord;
/** A half as compact JSON, for a QR code, a share link's ciphertext or an XMTP message. */
export declare function encodeHandshakeHalf(half: HandshakeHalf): string;
/**
 * Parse a half, refusing unknown fields and wrong types. Parsing is not
 * checking: run `verifyHandshakeHalf` next.
 *
 * @throws HandshakeError('malformed')
 */
export declare function decodeHandshakeHalf(text: string): HandshakeHalf;
/** A rename notice as JSON, for an XMTP message. */
export declare function encodeRenameNotice(notice: RenameNotice): string;
/**
 * Parse a rename notice, refusing unknown fields and wrong types. Run
 * `verifyRenameNotice` next.
 *
 * @throws HandshakeError('malformed')
 */
export declare function decodeRenameNotice(text: string): RenameNotice;
//# sourceMappingURL=handshake.d.ts.map