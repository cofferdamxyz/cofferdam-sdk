// The handshake (workspace decision 0086 rule 8, under decision 0039): the
// signed half and its reply, the pairwise secret, the rename notice
// (rule 7) and the contact record.
//
// A half carries the handle, its `handleId` and `serial`, the Tier 1 inbox
// id, a fresh X25519 public key, a nonce, an expiry (10 minutes on a QR code,
// 7 days on a link or a card), the intended peer's handle when known, and
// the handle key's EIP-712 signature over all of it. The reply half adds the
// digest of the half it answers.
//
//   secret = HKDF-SHA256(ikm = X25519(own ephemeral, peer ephemeral),
//                        salt = "cofferdam-handshake-v1",
//                        info = min(handleIdA, handleIdB) ‖ max(…) ‖ keccak256(digest(first) ‖ digest(reply)))
//
// The secret is never sent. Each ephemeral private key is the caller's to
// delete when the handshake completes or expires. The contact record holds
// no address (rule 8).

import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { keccak_256 } from '@noble/hashes/sha3'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils'
import {
  getAddress,
  getBytes,
  hexlify,
  recoverAddress,
  SigningKey,
  TypedDataEncoder,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers'
import { handleId as computeHandleId, isHandle } from './handle.js'
import { secp256k1Address } from './stealth.js'

/** Version of the half, the notice and the contact record. */
export const HANDSHAKE_VERSION = 1
/** Lifetime of a half shown as a QR code: 10 minutes (0086 rule 8). */
export const HANDSHAKE_QR_LIFETIME_S = 10 * 60
/** Lifetime of a half on a share link or an introduction card: 7 days (0086 rule 8). */
export const HANDSHAKE_LINK_LIFETIME_S = 7 * 24 * 60 * 60
/** Clock skew tolerated on an expiry: 5 minutes. */
export const HANDSHAKE_MAX_SKEW_S = 5 * 60
/** HKDF salt of the pairwise secret (0086 rule 8). Frozen. */
export const HANDSHAKE_SECRET_SALT = 'cofferdam-handshake-v1'
/** Name of the handshake's EIP-712 domain. */
export const HANDSHAKE_DOMAIN_NAME = 'CofferdamHandshake'

const ZERO32 = '0x' + '00'.repeat(32)
const MAX_INBOX_ID = 128
const MAX_STATEMENT = 4096
const MAX_TEXT = 256

/** A handshake refused, with the reason as a code. */
export class HandshakeError extends Error {
  constructor(
    readonly code:
      | 'malformed'
      | 'bad-signature'
      | 'expired'
      | 'lifetime'
      | 'replayed'
      | 'owner-mismatch'
      | 'serial-mismatch'
      | 'frozen'
      | 'pending-change'
      | 'wrong-peer'
      | 'wrong-reply',
    message: string,
  ) {
    super(message)
    this.name = 'HandshakeError'
  }
}

// ASSUMPTION(0086 rule 8): 0086 says the handle key signs the half; the
// EIP-712 domain (`CofferdamHandshake` v1, chainId only, so a Sepolia half
// never checks on mainnet), the field names, an empty `peerHandle` for "no
// peer named" and a zero `replyTo` for a first half are this build's.
/**
 * The handshake's EIP-712 domain.
 *
 * @param chainId - The chain of the anchor the halves are checked against.
 */
export function handshakeDomain(chainId: number): TypedDataDomain {
  return { name: HANDSHAKE_DOMAIN_NAME, version: '1', chainId }
}

const f = (name: string, type: string): TypedDataField => ({ name, type })

/** The EIP-712 types of the half and the rename notice. */
export const HANDSHAKE_TYPES = Object.freeze({
  HandshakeHalf: [
    f('handle', 'string'),
    f('handleId', 'bytes32'),
    f('serial', 'uint64'),
    f('inboxId', 'string'),
    f('ephemeralKey', 'bytes32'),
    f('nonce', 'bytes32'),
    f('expiresAt', 'uint64'),
    f('peerHandle', 'string'),
    f('replyTo', 'bytes32'),
  ],
  RenameNotice: [
    f('oldHandle', 'string'),
    f('oldHandleId', 'bytes32'),
    f('oldSerial', 'uint64'),
    f('oldOwner', 'address'),
    f('newHandle', 'string'),
    f('newHandleId', 'bytes32'),
    f('newSerial', 'uint64'),
    f('newOwner', 'address'),
    f('issuedAt', 'uint64'),
  ],
} satisfies Record<string, TypedDataField[]>)

/** One signed half (0086 rule 8). Hex fields are 0x-prefixed lowercase. */
export interface HandshakeHalf {
  v: 1
  /** The sender's handle, stored form. */
  handle: string
  handleId: string
  serial: number
  /** The sender's Tier 1 XMTP inbox id. */
  inboxId: string
  /** The X25519 public key, 32 bytes. */
  ephemeralKey: string
  /** 32 random bytes. */
  nonce: string
  /** Unix seconds. */
  expiresAt: number
  /** The intended peer's handle, or null when not known. */
  peerHandle: string | null
  /** Digest of the half this one answers; null on a first half. */
  replyTo: string | null
  /** The handle key's 65-byte signature. */
  signature: string
}

function halfMessage(half: Omit<HandshakeHalf, 'signature' | 'v'>): Record<string, unknown> {
  return {
    handle: half.handle,
    handleId: half.handleId,
    serial: half.serial,
    inboxId: half.inboxId,
    ephemeralKey: half.ephemeralKey,
    nonce: half.nonce,
    expiresAt: half.expiresAt,
    peerHandle: half.peerHandle ?? '',
    replyTo: half.replyTo ?? ZERO32,
  }
}

/**
 * The EIP-712 digest of a half: what the handle key signs, what a reply's
 * `replyTo` names, and what the pairwise secret's info binds.
 */
export function handshakeHalfDigest(half: HandshakeHalf, chainId: number): string {
  return TypedDataEncoder.hash(handshakeDomain(chainId), { HandshakeHalf: HANDSHAKE_TYPES.HandshakeHalf }, halfMessage(half))
}

function nowSeconds(now?: number): number {
  return Math.floor((now ?? Date.now()) / 1000)
}

/** What a new half needs. */
export interface CreateHandshakeHalfInput {
  /** The current epoch's handle key, 32 bytes. */
  handleKey: Uint8Array
  handle: string
  serial: number
  inboxId: string
  chainId: number
  /** `qr` (10 minutes) or `link` (7 days, also an introduction card). */
  carrier: 'qr' | 'link'
  peerHandle?: string | null | undefined
  /** Milliseconds; `Date.now()` by default. */
  now?: number | undefined
}

/**
 * Make a first half. The returned ephemeral private key stays on the phone
 * until the handshake completes or expires, then the caller deletes it.
 */
export function createHandshakeHalf(input: CreateHandshakeHalfInput): { half: HandshakeHalf; ephemeralPrivateKey: Uint8Array } {
  return makeHalf(input, null)
}

/**
 * Make the reply to a half that `verifyHandshakeHalf` accepted: it names the
 * first half's sender as the peer and its digest as `replyTo`.
 */
export function createHandshakeReply(
  first: HandshakeHalf,
  input: Omit<CreateHandshakeHalfInput, 'peerHandle'>,
): { half: HandshakeHalf; ephemeralPrivateKey: Uint8Array } {
  return makeHalf({ ...input, peerHandle: first.handle }, handshakeHalfDigest(first, input.chainId))
}

function makeHalf(input: CreateHandshakeHalfInput, replyTo: string | null): { half: HandshakeHalf; ephemeralPrivateKey: Uint8Array } {
  if (!isHandle(input.handle)) throw new HandshakeError('malformed', 'handshake: not a handle in its stored form')
  if (input.peerHandle != null && !isHandle(input.peerHandle)) {
    throw new HandshakeError('malformed', 'handshake: the peer handle is not in its stored form')
  }
  assertSerial(input.serial)
  assertText('inboxId', input.inboxId, MAX_INBOX_ID, true)
  const ephemeralPrivateKey = randomBytes(32)
  const body = {
    handle: input.handle,
    handleId: computeHandleId(input.handle),
    serial: input.serial,
    inboxId: input.inboxId,
    ephemeralKey: hexlify(x25519.getPublicKey(ephemeralPrivateKey)),
    nonce: hexlify(randomBytes(32)),
    expiresAt: nowSeconds(input.now) + (input.carrier === 'qr' ? HANDSHAKE_QR_LIFETIME_S : HANDSHAKE_LINK_LIFETIME_S),
    peerHandle: input.peerHandle ?? null,
    replyTo,
  }
  const unsigned: HandshakeHalf = { v: 1, ...body, signature: '' }
  const digest = handshakeHalfDigest(unsigned, input.chainId)
  return { half: { ...unsigned, signature: new SigningKey(hexlify(input.handleKey)).sign(digest).serialized }, ephemeralPrivateKey }
}

/** The anchor record a half is checked against, as the client read it from Base. */
export interface HandshakeAnchorView {
  owner: string
  serial: number
  /** `frozenUntil` is in the future. */
  frozen: boolean
  /** A change is pending. */
  pendingChange: boolean
}

/** What a check of a half found. */
export interface HandshakeHalfCheck {
  /** `checked` against the anchor; `unchecked` when no anchor was given (scanned offline). */
  status: 'checked' | 'unchecked'
  /** The address that signed it; compare with the anchor's `owner` once online. */
  signer: string
  digest: string
}

/**
 * Check a half (0086 rule 8): well-formed, signed, not expired, not
 * replayed, for this peer, and, with an anchor, signed by its `owner` at the
 * same `serial` on a record neither frozen nor with a pending change.
 * Without an anchor the half is `unchecked`, and the caller checks it again
 * with `checkHandshakeSigner` when the phone is next online.
 *
 * @param opts.isReplay - Whether this nonce was seen before; the caller
 *   records it once the half is accepted.
 * @param opts.selfHandle - The verifier's own handle: a half naming another peer is refused.
 * @param opts.inReplyTo - For a reply, the first half it must answer.
 * @throws HandshakeError
 */
export function verifyHandshakeHalf(
  half: HandshakeHalf,
  opts: {
    chainId: number
    now?: number | undefined
    anchor?: HandshakeAnchorView | null | undefined
    isReplay?: ((nonce: string) => boolean) | undefined
    selfHandle?: string | undefined
    inReplyTo?: HandshakeHalf | undefined
    /** The carrier it arrived by: a `qr` half may live 10 minutes at most. */
    carrier?: 'qr' | 'link' | undefined
  },
): HandshakeHalfCheck {
  assertHalfShape(half)
  if (computeHandleId(half.handle) !== half.handleId) {
    throw new HandshakeError('malformed', 'handshake: the handleId is not the handle’s')
  }
  const digest = handshakeHalfDigest(half, opts.chainId)
  let signer: string
  try {
    signer = recoverAddress(digest, half.signature)
  } catch {
    throw new HandshakeError('bad-signature', 'handshake: the signature does not recover')
  }
  const now = nowSeconds(opts.now)
  if (now > half.expiresAt) throw new HandshakeError('expired', 'handshake: the half has expired')
  const lifetime = opts.carrier === 'qr' ? HANDSHAKE_QR_LIFETIME_S : HANDSHAKE_LINK_LIFETIME_S
  if (half.expiresAt - now > lifetime + HANDSHAKE_MAX_SKEW_S) {
    throw new HandshakeError('lifetime', 'handshake: the half lives longer than its carrier allows')
  }
  if (opts.selfHandle !== undefined && half.peerHandle !== null && half.peerHandle !== opts.selfHandle) {
    throw new HandshakeError('wrong-peer', 'handshake: the half names another peer')
  }
  if (opts.inReplyTo !== undefined) {
    if (half.replyTo !== handshakeHalfDigest(opts.inReplyTo, opts.chainId)) {
      throw new HandshakeError('wrong-reply', 'handshake: the reply does not answer this half')
    }
    if (half.handleId === opts.inReplyTo.handleId) {
      throw new HandshakeError('wrong-reply', 'handshake: a handle cannot answer itself')
    }
  }
  if (opts.isReplay?.(half.nonce)) throw new HandshakeError('replayed', 'handshake: the nonce was seen before')
  if (!opts.anchor) return { status: 'unchecked', signer, digest }
  checkHandshakeSigner(half, signer, opts.anchor)
  return { status: 'checked', signer, digest }
}

/**
 * The anchor half of the check: the signer is the record's `owner`, at the
 * half's `serial`, and the record is neither frozen nor has a pending change.
 * For a half kept `unchecked`, run it when the phone is next online.
 *
 * @throws HandshakeError
 */
export function checkHandshakeSigner(half: HandshakeHalf, signer: string, anchor: HandshakeAnchorView): void {
  if (getAddress(signer) !== getAddress(anchor.owner)) {
    throw new HandshakeError('owner-mismatch', 'handshake: not signed by the anchor’s owner')
  }
  if (anchor.serial !== half.serial) throw new HandshakeError('serial-mismatch', 'handshake: the handle changed hands')
  if (anchor.frozen) throw new HandshakeError('frozen', 'handshake: the handle is frozen')
  if (anchor.pendingChange) throw new HandshakeError('pending-change', 'handshake: the handle has a pending change')
}

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
export function deriveHandshakeSecret(input: {
  ephemeralPrivateKey: Uint8Array
  first: HandshakeHalf
  reply: HandshakeHalf
  chainId: number
}): Uint8Array {
  const { first, reply, chainId } = input
  const firstDigest = handshakeHalfDigest(first, chainId)
  if (reply.replyTo !== firstDigest) throw new HandshakeError('wrong-reply', 'handshake: the reply does not answer the first half')
  const own = hexlify(x25519.getPublicKey(input.ephemeralPrivateKey))
  let peer: string
  if (own === first.ephemeralKey) peer = reply.ephemeralKey
  else if (own === reply.ephemeralKey) peer = first.ephemeralKey
  else throw new HandshakeError('malformed', 'handshake: the private key is neither half’s')
  const shared = x25519.getSharedSecret(input.ephemeralPrivateKey, getBytes(peer))
  if (shared.every((b) => b === 0)) throw new HandshakeError('malformed', 'handshake: a low-order X25519 key')
  const [a, b] = [getBytes(first.handleId), getBytes(reply.handleId)].sort(compareBytes)
  // ASSUMPTION(0086 rule 8): "the hash of both halves" is keccak256 of the
  // first half's EIP-712 digest then the reply's.
  const halves = keccak_256(concat(getBytes(firstDigest), getBytes(handshakeHalfDigest(reply, chainId))))
  try {
    return hkdf(sha256, shared, utf8ToBytes(HANDSHAKE_SECRET_SALT), concat(a!, b!, halves), 32)
  } finally {
    shared.fill(0)
  }
}

// ---------------------------------------------------------------------------
// Rename notice (0086 rule 7)
// ---------------------------------------------------------------------------

/**
 * A rename notice sent to each contact over XMTP: old `handleId` → new
 * `handleId`, signed by both handle keys, carrying the plane's same-identity
 * statement. Whether a contact follows it (the anchor conditions of rule 7,
 * question 23) is the app's check.
 */
export interface RenameNotice {
  v: 1
  oldHandle: string
  oldHandleId: string
  oldSerial: number
  oldOwner: string
  newHandle: string
  newHandleId: string
  newSerial: number
  newOwner: string
  /** Unix seconds. */
  issuedAt: number
  oldSignature: string
  newSignature: string
  /** The plane's signed statement that both handles belong to one identity, as the plane encodes it; carried, never published. */
  identityStatement: string
}

function noticeMessage(n: Omit<RenameNotice, 'v' | 'oldSignature' | 'newSignature' | 'identityStatement'>): Record<string, unknown> {
  return {
    oldHandle: n.oldHandle,
    oldHandleId: n.oldHandleId,
    oldSerial: n.oldSerial,
    oldOwner: n.oldOwner,
    newHandle: n.newHandle,
    newHandleId: n.newHandleId,
    newSerial: n.newSerial,
    newOwner: n.newOwner,
    issuedAt: n.issuedAt,
  }
}

/** The EIP-712 digest both handle keys sign. */
export function renameNoticeDigest(notice: RenameNotice, chainId: number): string {
  return TypedDataEncoder.hash(handshakeDomain(chainId), { RenameNotice: HANDSHAKE_TYPES.RenameNotice }, noticeMessage(notice))
}

/** Make a rename notice signed by the old and the new handle keys. */
export function createRenameNotice(input: {
  oldHandleKey: Uint8Array
  newHandleKey: Uint8Array
  oldHandle: string
  oldSerial: number
  newHandle: string
  newSerial: number
  identityStatement: string
  chainId: number
  now?: number | undefined
}): RenameNotice {
  for (const h of [input.oldHandle, input.newHandle]) {
    if (!isHandle(h)) throw new HandshakeError('malformed', 'handshake: not a handle in its stored form')
  }
  const unsigned: RenameNotice = {
    v: 1,
    oldHandle: input.oldHandle,
    oldHandleId: computeHandleId(input.oldHandle),
    oldSerial: input.oldSerial,
    oldOwner: secp256k1Address(input.oldHandleKey),
    newHandle: input.newHandle,
    newHandleId: computeHandleId(input.newHandle),
    newSerial: input.newSerial,
    newOwner: secp256k1Address(input.newHandleKey),
    issuedAt: nowSeconds(input.now),
    oldSignature: '',
    newSignature: '',
    identityStatement: input.identityStatement,
  }
  assertNoticeShape(unsigned, false)
  const digest = renameNoticeDigest(unsigned, input.chainId)
  return {
    ...unsigned,
    oldSignature: new SigningKey(hexlify(input.oldHandleKey)).sign(digest).serialized,
    newSignature: new SigningKey(hexlify(input.newHandleKey)).sign(digest).serialized,
  }
}

/**
 * Check a rename notice's own consistency: both handle ids match their
 * handles, and the old and new keys both signed it. The caller then checks
 * `oldOwner` and `newOwner` against the anchor and the identity statement
 * against the plane's key (rule 7).
 *
 * @throws HandshakeError
 */
export function verifyRenameNotice(notice: RenameNotice, chainId: number): void {
  assertNoticeShape(notice, true)
  if (computeHandleId(notice.oldHandle) !== notice.oldHandleId || computeHandleId(notice.newHandle) !== notice.newHandleId) {
    throw new HandshakeError('malformed', 'handshake: a handleId is not its handle’s')
  }
  const digest = renameNoticeDigest(notice, chainId)
  for (const [sig, owner] of [
    [notice.oldSignature, notice.oldOwner],
    [notice.newSignature, notice.newOwner],
  ] as const) {
    let signer: string
    try {
      signer = recoverAddress(digest, sig)
    } catch {
      throw new HandshakeError('bad-signature', 'handshake: a notice signature does not recover')
    }
    if (signer !== getAddress(owner)) throw new HandshakeError('bad-signature', 'handshake: a notice signature is not its key’s')
  }
}

// ---------------------------------------------------------------------------
// Contact record (0086 rule 8)
// ---------------------------------------------------------------------------

/** How a contact was made (0039's table, 0086 rule 8). */
export type ContactPath = 'in-person' | 'share-link' | 'job-award' | 'introduction' | 'find-me'
const CONTACT_PATHS: readonly ContactPath[] = ['in-person', 'share-link', 'job-award', 'introduction', 'find-me']

/**
 * A contact as the Vault's `contacts` table keeps it (0086 rule 8). It holds
 * no address: a payment resolves the handle each time.
 */
export interface ContactRecord {
  v: 1
  handle: string
  handleId: string
  serial: number
  /** The anchor's `owner` at the handshake. */
  ownerAtHandshake: string
  inboxId: string
  /** The pairwise secret, 32 bytes. */
  pairwiseSecret: Uint8Array
  path: ContactPath
  /** The two signed halves. */
  receipt: { first: HandshakeHalf; reply: HandshakeHalf }
  /** The filter the peer gave, or null before it arrives. */
  filterReceived: Uint8Array | null
  /** The name the peer chose to send, or null. */
  name: string | null
  /** The avatar the peer chose to send (a reference the app resolves), or null. */
  avatar: string | null
  sharesContacts: boolean
  /** Milliseconds since the epoch. */
  createdAt: number
}

const MAX_FILTER_BYTES = 4096

/**
 * Encode a contact record as UTF-8 JSON with hex bytes, ready for the Vault
 * store (which encrypts it).
 *
 * @throws HandshakeError('malformed') for a record `decodeContactRecord` would refuse.
 */
export function encodeContactRecord(record: ContactRecord): Uint8Array {
  const json = {
    v: record.v,
    handle: record.handle,
    handleId: record.handleId,
    serial: record.serial,
    ownerAtHandshake: record.ownerAtHandshake,
    inboxId: record.inboxId,
    pairwiseSecret: hexlify(record.pairwiseSecret),
    path: record.path,
    receipt: { first: record.receipt.first, reply: record.receipt.reply },
    filterReceived: record.filterReceived === null ? null : hexlify(record.filterReceived),
    name: record.name,
    avatar: record.avatar,
    sharesContacts: record.sharesContacts,
    createdAt: record.createdAt,
  }
  const bytes = utf8ToBytes(JSON.stringify(json))
  decodeContactRecord(bytes) // the encoder never writes what the decoder refuses
  return bytes
}

/**
 * Decode a contact record, refusing unknown fields, a wrong type anywhere and
 * any field that could hold an address beyond the owner at handshake.
 *
 * @throws HandshakeError('malformed')
 */
export function decodeContactRecord(bytes: Uint8Array): ContactRecord {
  let o: unknown
  try {
    o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new HandshakeError('malformed', 'handshake: the contact record is not JSON')
  }
  const r = asObject(o, 'contact record', [
    'v',
    'handle',
    'handleId',
    'serial',
    'ownerAtHandshake',
    'inboxId',
    'pairwiseSecret',
    'path',
    'receipt',
    'filterReceived',
    'name',
    'avatar',
    'sharesContacts',
    'createdAt',
  ])
  if (r.v !== HANDSHAKE_VERSION) throw new HandshakeError('malformed', 'handshake: unknown contact record version')
  const handle = r.handle
  if (typeof handle !== 'string' || !isHandle(handle)) throw new HandshakeError('malformed', 'handshake: bad contact handle')
  assertHex32('handleId', r.handleId)
  if (computeHandleId(handle) !== r.handleId) throw new HandshakeError('malformed', 'handshake: the handleId is not the handle’s')
  assertSerial(r.serial)
  const owner = assertAddress('ownerAtHandshake', r.ownerAtHandshake)
  assertText('inboxId', r.inboxId, MAX_INBOX_ID, true)
  assertHex32('pairwiseSecret', r.pairwiseSecret)
  if (typeof r.path !== 'string' || !CONTACT_PATHS.includes(r.path as ContactPath)) {
    throw new HandshakeError('malformed', 'handshake: unknown contact path')
  }
  const receipt = asObject(r.receipt, 'receipt', ['first', 'reply'])
  assertHalfShape(receipt.first)
  assertHalfShape(receipt.reply)
  let filterReceived: Uint8Array | null = null
  if (r.filterReceived !== null) {
    if (typeof r.filterReceived !== 'string' || !/^0x([0-9a-f]{2})*$/.test(r.filterReceived)) {
      throw new HandshakeError('malformed', 'handshake: bad filter')
    }
    filterReceived = getBytes(r.filterReceived)
    if (filterReceived.length > MAX_FILTER_BYTES) throw new HandshakeError('malformed', 'handshake: filter too large')
  }
  for (const k of ['name', 'avatar'] as const) {
    if (r[k] !== null) assertText(k, r[k], k === 'avatar' ? MAX_STATEMENT : MAX_TEXT, false)
  }
  if (typeof r.sharesContacts !== 'boolean') throw new HandshakeError('malformed', 'handshake: bad sharesContacts')
  if (typeof r.createdAt !== 'number' || !Number.isSafeInteger(r.createdAt) || r.createdAt < 0) {
    throw new HandshakeError('malformed', 'handshake: bad createdAt')
  }
  return {
    v: 1,
    handle,
    handleId: r.handleId as string,
    serial: r.serial as number,
    ownerAtHandshake: owner,
    inboxId: r.inboxId as string,
    pairwiseSecret: getBytes(r.pairwiseSecret as string),
    path: r.path as ContactPath,
    receipt: { first: receipt.first as HandshakeHalf, reply: receipt.reply as HandshakeHalf },
    filterReceived,
    name: r.name as string | null,
    avatar: r.avatar as string | null,
    sharesContacts: r.sharesContacts,
    createdAt: r.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Wire codecs of the half and the notice
// ---------------------------------------------------------------------------

/** A half as compact JSON, for a QR code, a share link's ciphertext or an XMTP message. */
export function encodeHandshakeHalf(half: HandshakeHalf): string {
  assertHalfShape(half)
  return JSON.stringify(half)
}

/**
 * Parse a half, refusing unknown fields and wrong types. Parsing is not
 * checking: run `verifyHandshakeHalf` next.
 *
 * @throws HandshakeError('malformed')
 */
export function decodeHandshakeHalf(text: string): HandshakeHalf {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    throw new HandshakeError('malformed', 'handshake: the half is not JSON')
  }
  assertHalfShape(o)
  return o
}

/** A rename notice as JSON, for an XMTP message. */
export function encodeRenameNotice(notice: RenameNotice): string {
  assertNoticeShape(notice, true)
  return JSON.stringify(notice)
}

/**
 * Parse a rename notice, refusing unknown fields and wrong types. Run
 * `verifyRenameNotice` next.
 *
 * @throws HandshakeError('malformed')
 */
export function decodeRenameNotice(text: string): RenameNotice {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    throw new HandshakeError('malformed', 'handshake: the notice is not JSON')
  }
  assertNoticeShape(o, true)
  return o
}

// ---------------------------------------------------------------------------
// Shape checks
// ---------------------------------------------------------------------------

const HALF_KEYS = ['v', 'handle', 'handleId', 'serial', 'inboxId', 'ephemeralKey', 'nonce', 'expiresAt', 'peerHandle', 'replyTo', 'signature']
const NOTICE_KEYS = [
  'v',
  'oldHandle',
  'oldHandleId',
  'oldSerial',
  'oldOwner',
  'newHandle',
  'newHandleId',
  'newSerial',
  'newOwner',
  'issuedAt',
  'oldSignature',
  'newSignature',
  'identityStatement',
]

function assertHalfShape(o: unknown): asserts o is HandshakeHalf {
  const h = asObject(o, 'half', HALF_KEYS)
  if (h.v !== HANDSHAKE_VERSION) throw new HandshakeError('malformed', 'handshake: unknown half version')
  if (typeof h.handle !== 'string' || !isHandle(h.handle)) throw new HandshakeError('malformed', 'handshake: bad handle')
  assertHex32('handleId', h.handleId)
  assertSerial(h.serial)
  assertText('inboxId', h.inboxId, MAX_INBOX_ID, true)
  assertHex32('ephemeralKey', h.ephemeralKey)
  assertHex32('nonce', h.nonce)
  if (typeof h.expiresAt !== 'number' || !Number.isSafeInteger(h.expiresAt) || h.expiresAt <= 0) {
    throw new HandshakeError('malformed', 'handshake: bad expiresAt')
  }
  if (h.peerHandle !== null && (typeof h.peerHandle !== 'string' || !isHandle(h.peerHandle))) {
    throw new HandshakeError('malformed', 'handshake: bad peerHandle')
  }
  if (h.replyTo !== null) {
    assertHex32('replyTo', h.replyTo)
    if (h.replyTo === ZERO32) throw new HandshakeError('malformed', 'handshake: a zero replyTo is written as null')
  }
  assertSignature('signature', h.signature)
}

function assertNoticeShape(o: unknown, signed: boolean): asserts o is RenameNotice {
  const n = asObject(o, 'notice', NOTICE_KEYS)
  if (n.v !== HANDSHAKE_VERSION) throw new HandshakeError('malformed', 'handshake: unknown notice version')
  for (const k of ['oldHandle', 'newHandle'] as const) {
    if (typeof n[k] !== 'string' || !isHandle(n[k])) throw new HandshakeError('malformed', `handshake: bad ${k}`)
  }
  if (n.oldHandle === n.newHandle) throw new HandshakeError('malformed', 'handshake: a rename keeps no label')
  assertHex32('oldHandleId', n.oldHandleId)
  assertHex32('newHandleId', n.newHandleId)
  assertSerial(n.oldSerial)
  assertSerial(n.newSerial)
  assertAddress('oldOwner', n.oldOwner)
  assertAddress('newOwner', n.newOwner)
  if (typeof n.issuedAt !== 'number' || !Number.isSafeInteger(n.issuedAt) || n.issuedAt < 0) {
    throw new HandshakeError('malformed', 'handshake: bad issuedAt')
  }
  if (signed) {
    assertSignature('oldSignature', n.oldSignature)
    assertSignature('newSignature', n.newSignature)
  }
  assertText('identityStatement', n.identityStatement, MAX_STATEMENT, true)
}

function asObject(o: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new HandshakeError('malformed', `handshake: the ${what} is not an object`)
  const rec = o as Record<string, unknown>
  const own = Object.keys(rec)
  if (own.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(rec, k))) {
    throw new HandshakeError('malformed', `handshake: the ${what} has missing or unknown fields`)
  }
  return rec
}

function assertHex32(name: string, v: unknown): void {
  if (typeof v !== 'string' || !/^0x[0-9a-f]{64}$/.test(v)) throw new HandshakeError('malformed', `handshake: ${name} must be 32 bytes of lowercase hex`)
}

function assertSignature(name: string, v: unknown): void {
  if (typeof v !== 'string' || !/^0x[0-9a-f]{130}$/.test(v)) throw new HandshakeError('malformed', `handshake: ${name} must be a 65-byte signature`)
}

function assertSerial(v: unknown): void {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new HandshakeError('malformed', 'handshake: bad serial')
}

function assertAddress(name: string, v: unknown): string {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new HandshakeError('malformed', `handshake: bad ${name}`)
  try {
    const a = getAddress(v)
    if (a !== v) throw new Error('not checksummed')
    return a
  } catch {
    throw new HandshakeError('malformed', `handshake: ${name} must be a checksummed address`)
  }
}

function assertText(name: string, v: unknown, max: number, nonEmpty: boolean): void {
  if (typeof v !== 'string' || v.length > max || (nonEmpty && v.length === 0)) {
    throw new HandshakeError('malformed', `handshake: bad ${name}`)
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
