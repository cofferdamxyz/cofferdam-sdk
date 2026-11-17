// The handle: its grammar, its id, and the EIP-712 types of everything signed
// about it (workspace decision 0086 rules 2 to 4 and 7; decision 0029 (1)).
//
// Grammar (0029 (1), kept by 0083 R11; 0086 question 9): an `@handle` is an
// ENS label, lowercase a–z, 0–9 and the hyphen, no hyphen at either end,
// normalised with ENSIP-15 (ethers' `ensNormalize`, which also refuses `--`
// in the third and fourth places), 3 to 64 characters. The app's picker, the
// plane's registry and the pay-link page all read `toHandle`.
//
//   handleId = keccak256("cofferdam-handle-v1:" ‖ label)        (0086 rule 2)
//
// EIP-712. Two domains:
// - `CofferdamHandleAnchor` v1 on the anchor contract (chainId and
//   verifyingContract): every signed call of `CofferdamHandleAnchor`;
// - `CofferdamHandleRegistry` v1 on the plane (chainId only): the registry's
//   handle-scoped requests.
// The Safe's `rekey`, `forceRelease` and registrar list are direct Safe calls
// and have no type. The shared fixture `test/fixtures/handleAnchorTypes.json`
// pins every type string, typehash and a signature of each from fixed keys,
// for the anchor contract's and the plane's tests.

import { keccak_256 } from '@noble/hashes/sha3'
import { utf8ToBytes } from '@noble/hashes/utils'
import {
  ensNormalize,
  getAddress,
  hexlify,
  recoverAddress,
  SigningKey,
  TypedDataEncoder,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers'

/** Shortest handle (0086 question 9). */
export const HANDLE_MIN_LENGTH = 3
/** Longest handle. */
export const HANDLE_MAX_LENGTH = 64

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * The handle in its one stored form (the label, without `@`), or null when
 * the input is no handle. A leading `@` and surrounding space are dropped and
 * the rest normalised with ENSIP-15 (`Ana` → `ana`, full-width letters
 * folded), then held to the label rules.
 *
 * @param input - What the user typed or a peer sent.
 */
export function toHandle(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim().replace(/^@/, '')
  if (!raw) return null
  let label: string
  try {
    label = ensNormalize(raw)
  } catch {
    return null
  }
  if (label.length < HANDLE_MIN_LENGTH || label.length > HANDLE_MAX_LENGTH) return null
  return LABEL.test(label) ? label : null
}

/**
 * Whether `handle` is already in its stored form: what the registry keeps
 * and what `handleId` takes.
 */
export function isHandle(handle: string | null | undefined): boolean {
  return !!handle && toHandle(handle) === handle
}

/** The domain prefix of `handleId` (0086 rule 2). Frozen. */
export const HANDLE_ID_PREFIX = 'cofferdam-handle-v1:'

/**
 * The anchor's key for a label (0086 rule 2): keccak256 of
 * `cofferdam-handle-v1:` and the label's UTF-8 bytes. It names no parent.
 *
 * @param label - A handle in its stored form (`isHandle`).
 * @returns 0x-prefixed 32 bytes.
 * @throws when the label is not in its stored form.
 */
export function handleId(label: string): string {
  if (!isHandle(label)) throw new Error('handle: not a handle in its stored form')
  return hexlify(keccak_256(utf8ToBytes(HANDLE_ID_PREFIX + label)))
}

// ---------------------------------------------------------------------------
// EIP-712
// ---------------------------------------------------------------------------

/** Name of the anchor's EIP-712 domain. */
export const HANDLE_ANCHOR_DOMAIN_NAME = 'CofferdamHandleAnchor'
/** Name of the registry's EIP-712 domain. */
export const HANDLE_REGISTRY_DOMAIN_NAME = 'CofferdamHandleRegistry'
/** Version of both domains. */
export const HANDLE_DOMAIN_VERSION = '1'

/**
 * The anchor's EIP-712 domain.
 *
 * @param chainId - Base (8453) or Base Sepolia (84532).
 * @param verifyingContract - The `CofferdamHandleAnchor` address, from the caller's configuration.
 */
export function handleAnchorDomain(chainId: number, verifyingContract: string): TypedDataDomain {
  return { name: HANDLE_ANCHOR_DOMAIN_NAME, version: HANDLE_DOMAIN_VERSION, chainId, verifyingContract: getAddress(verifyingContract) }
}

/**
 * The registry's EIP-712 domain: no contract, the chain of the anchor the
 * plane relays to.
 *
 * @param chainId - Base (8453) or Base Sepolia (84532).
 */
export function handleRegistryDomain(chainId: number): TypedDataDomain {
  return { name: HANDLE_REGISTRY_DOMAIN_NAME, version: HANDLE_DOMAIN_VERSION, chainId }
}

const f = (name: string, type: string): TypedDataField => ({ name, type })

// Field conventions, shared with the anchor contract:
// - `nonce` (uint256): the anchor's one per-handle counter of accepted signed
//   calls, read at signing time; every accepted call raises it, so a
//   signature is good once. The owner's change and the new key's
//   co-signature carry the same value.
// - `pendingNonce`: the `nonce` at which the pending change was queued, so a
//   cancel or a veto names one change.
// - `deadline` and `frozenUntil` (uint64): unix seconds.
// - `metaAddress` (bytes): the 66-byte scheme 1 meta-address.
// ASSUMPTION(0086 rule 3): 0086 gives the claim's fields and says each owner
// change carries a nonce; the per-handle nonce, the deadlines, `pendingNonce`
// and the co-signature structs are this build's, to be matched by step 2.

/**
 * Every signed call of `CofferdamHandleAnchor` (0086 rule 3), by primary type.
 * Each type is flat (no nested structs). Who signs each:
 * - `RegistrarClaim`: a registrar; `OwnerClaim`: the claiming handle key.
 * - `TransferOwner`, `SetMetaAddress`, `Release`, `Cancel`: the owner, taking
 *   effect after 72 hours (`Cancel` at once); `TransferOwnerAccept`: the new key.
 * - `Advance`: the owner; `AdvanceAccept`: the new key; `RegistrarAdvance`: a
 *   registrar, after a High ceremony. Immediate.
 * - `Hold`, `RenewHold`, `Veto`: a registrar, after a High ceremony.
 * - `Unfreeze`: the owner; `RegistrarUnfreeze`: a registrar (question 15, open).
 */
export const HANDLE_ANCHOR_TYPES = Object.freeze({
  RegistrarClaim: [f('handleId', 'bytes32'), f('owner', 'address'), f('serial', 'uint64'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  OwnerClaim: [f('handleId', 'bytes32'), f('metaAddress', 'bytes'), f('serial', 'uint64')],
  TransferOwner: [f('handleId', 'bytes32'), f('newOwner', 'address'), f('newMetaAddress', 'bytes'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  TransferOwnerAccept: [f('handleId', 'bytes32'), f('previousOwner', 'address'), f('newMetaAddress', 'bytes'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  SetMetaAddress: [f('handleId', 'bytes32'), f('newMetaAddress', 'bytes'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  Release: [f('handleId', 'bytes32'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  Cancel: [f('handleId', 'bytes32'), f('pendingNonce', 'uint256'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  Advance: [f('handleId', 'bytes32'), f('newOwner', 'address'), f('newMetaAddress', 'bytes'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  AdvanceAccept: [f('handleId', 'bytes32'), f('previousOwner', 'address'), f('newMetaAddress', 'bytes'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  RegistrarAdvance: [
    f('handleId', 'bytes32'),
    f('previousOwner', 'address'),
    f('newOwner', 'address'),
    f('newMetaAddress', 'bytes'),
    f('nonce', 'uint256'),
    f('deadline', 'uint64'),
  ],
  Hold: [f('handleId', 'bytes32'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  RenewHold: [f('handleId', 'bytes32'), f('frozenUntil', 'uint64'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  Veto: [f('handleId', 'bytes32'), f('pendingNonce', 'uint256'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  // ASSUMPTION(0086 q15): `unfreeze(handleId)` exists, signed by the owner
  // and a registrar, each naming the freeze it lifts by its `frozenUntil`.
  // Open; under question 15's alternative B both types go.
  Unfreeze: [f('handleId', 'bytes32'), f('frozenUntil', 'uint64'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  RegistrarUnfreeze: [f('handleId', 'bytes32'), f('frozenUntil', 'uint64'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  // ASSUMPTION(0086 q16): no owner brake on the Safe's pending `rekey`, so no type for one.
} satisfies Record<string, TypedDataField[]>)

// Registry requests carry a random 32-byte `nonce` the plane refuses to see
// twice before `expiresAt` (unix seconds), and the record's current `serial`
// where one exists, so a request made for an earlier holder never applies.
// ASSUMPTION(0086 rule 4): 0086 says these requests are signed by the handle
// key and lists what they cover; the fields are this build's.

/**
 * The registry's handle-scoped requests (0086 rules 4 to 7), signed by the
 * handle key:
 * - `RegistryClaim`: `POST /v1/handles/claim`, by the claiming key;
 * - `SetDiscoverable`: "Let people find me" on or off, with the Tier 1 inbox
 *   id only while on (empty when off);
 * - `RenameHandle`: by the old key, naming the new label and the next epoch's keys;
 * - `ReleaseHandle`: give the label up;
 * - `RegisterAddress`: the `self` route, an address the user's phone derived
 *   or found by a scan, with R, h and the meta-address it derives from.
 */
export const HANDLE_REGISTRY_TYPES = Object.freeze({
  RegistryClaim: [
    f('label', 'string'),
    f('handleId', 'bytes32'),
    f('owner', 'address'),
    f('metaAddress', 'bytes'),
    f('nonce', 'bytes32'),
    f('expiresAt', 'uint64'),
  ],
  SetDiscoverable: [
    f('handleId', 'bytes32'),
    f('serial', 'uint64'),
    f('discoverable', 'bool'),
    f('inboxId', 'string'),
    f('nonce', 'bytes32'),
    f('expiresAt', 'uint64'),
  ],
  RenameHandle: [
    f('handleId', 'bytes32'),
    f('serial', 'uint64'),
    f('newLabel', 'string'),
    f('newHandleId', 'bytes32'),
    f('newOwner', 'address'),
    f('newMetaAddress', 'bytes'),
    f('nonce', 'bytes32'),
    f('expiresAt', 'uint64'),
  ],
  ReleaseHandle: [f('handleId', 'bytes32'), f('serial', 'uint64'), f('nonce', 'bytes32'), f('expiresAt', 'uint64')],
  RegisterAddress: [
    f('handleId', 'bytes32'),
    f('serial', 'uint64'),
    f('account', 'address'),
    f('ephemeralPublicKey', 'bytes'),
    f('sharedSecretHash', 'bytes32'),
    f('metaAddress', 'bytes'),
    f('nonce', 'bytes32'),
    f('expiresAt', 'uint64'),
  ],
} satisfies Record<string, TypedDataField[]>)

/** A primary type of the anchor. */
export type HandleAnchorPrimaryType = keyof typeof HANDLE_ANCHOR_TYPES
/** A primary type of the registry. */
export type HandleRegistryPrimaryType = keyof typeof HANDLE_REGISTRY_TYPES
/** A primary type of either domain. */
export type HandlePrimaryType = HandleAnchorPrimaryType | HandleRegistryPrimaryType

/** A message: one value per field of its type (bigint or number for uints, 0x hex for bytes). */
export type HandleTypedMessage = Record<string, unknown>

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

function fieldsOf(primaryType: HandlePrimaryType): TypedDataField[] {
  const k = String(primaryType)
  if (own(HANDLE_ANCHOR_TYPES, k)) return (HANDLE_ANCHOR_TYPES as Record<string, TypedDataField[]>)[k]!
  if (own(HANDLE_REGISTRY_TYPES, k)) return (HANDLE_REGISTRY_TYPES as Record<string, TypedDataField[]>)[k]!
  throw new Error(`handle: unknown primary type ${k}`)
}

function checkDomain(domain: TypedDataDomain, primaryType: HandlePrimaryType): void {
  fieldsOf(primaryType)
  const anchor = own(HANDLE_ANCHOR_TYPES, primaryType)
  const want = anchor ? HANDLE_ANCHOR_DOMAIN_NAME : HANDLE_REGISTRY_DOMAIN_NAME
  if (domain.name !== want) throw new Error(`handle: ${primaryType} is signed in the ${want} domain`)
  if (domain.version !== HANDLE_DOMAIN_VERSION) throw new Error(`handle: the ${want} domain is version ${HANDLE_DOMAIN_VERSION}`)
  if (domain.chainId == null) throw new Error(`handle: the ${want} domain names a chain`)
  if (anchor !== (domain.verifyingContract != null)) {
    throw new Error(`handle: the ${want} domain ${anchor ? 'names' : 'names no'} verifyingContract`)
  }
  if (domain.salt != null) throw new Error(`handle: the ${want} domain has no salt`)
}

function typesFor(primaryType: HandlePrimaryType, message: HandleTypedMessage): Record<string, TypedDataField[]> {
  const fields = fieldsOf(primaryType)
  const names = new Set(fields.map((x) => x.name))
  for (const key of Object.keys(message)) {
    if (!names.has(key)) throw new Error(`handle: ${primaryType} has no field ${key}`)
  }
  for (const name of names) {
    if (!(name in message)) throw new Error(`handle: ${primaryType} is missing ${name}`)
  }
  return { [primaryType]: fields }
}

/**
 * The canonical EIP-712 type string of a primary type, e.g.
 * `Release(bytes32 handleId,uint256 nonce,uint64 deadline)`.
 */
export function handleTypeString(primaryType: HandlePrimaryType): string {
  return `${primaryType}(${fieldsOf(primaryType)
    .map((x) => `${x.type} ${x.name}`)
    .join(',')})`
}

/**
 * The EIP-712 digest of a handle message: what a key signs.
 *
 * @param domain - `handleAnchorDomain` or `handleRegistryDomain`, matching the type.
 * @param primaryType - One of `HANDLE_ANCHOR_TYPES` or `HANDLE_REGISTRY_TYPES`.
 * @param message - Exactly the type's fields.
 * @returns 0x-prefixed 32 bytes.
 */
export function handleTypedDataDigest(domain: TypedDataDomain, primaryType: HandlePrimaryType, message: HandleTypedMessage): string {
  checkDomain(domain, primaryType)
  return TypedDataEncoder.hash(domain, typesFor(primaryType, message), message)
}

/**
 * Sign a handle message with a secp256k1 key (the handle key, a release key,
 * or a registrar's key in the plane's tests).
 *
 * @returns The 65-byte signature r ‖ s ‖ v (v 27 or 28, low s), 0x hex.
 */
export function signHandleTypedData(
  privateKey: Uint8Array,
  domain: TypedDataDomain,
  primaryType: HandlePrimaryType,
  message: HandleTypedMessage,
): string {
  const digest = handleTypedDataDigest(domain, primaryType, message)
  return new SigningKey(hexlify(privateKey)).sign(digest).serialized
}

/**
 * The address that signed a handle message, or null for a malformed
 * signature. The caller compares it with the anchor's `owner` (or a
 * registrar); the address alone proves nothing.
 */
export function recoverHandleTypedDataSigner(
  domain: TypedDataDomain,
  primaryType: HandlePrimaryType,
  message: HandleTypedMessage,
  signature: string,
): string | null {
  const digest = handleTypedDataDigest(domain, primaryType, message)
  try {
    return recoverAddress(digest, signature)
  } catch {
    return null
  }
}
