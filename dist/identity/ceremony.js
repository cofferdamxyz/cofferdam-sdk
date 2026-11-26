// The Cofferdam ceremony attestation as EIP-712 typed data (workspace decision
// 0090 item 5, ruled 2026-11-26; decision 0016 for the ceremony itself).
//
// A ceremony attester co-signs the first High on a Partner or Managed account
// (`enrollFirstHigh`), the pre-High Partner re-key (`replacePartnerAuthority`)
// and hard recovery (`recoverHigh`). From the production account generation of
// decision 0080 on, `CofferdamAccount4337` verifies that co-sign as EIP-712 so
// a CDP policy can pin what the attester signs (`signEvmTypedData` by
// `verifyingContract` and `primaryType`):
//
//   domain  EIP712Domain(name "Cofferdam Ceremony", version "1", chainId,
//           verifyingContract = the generation's CofferdamCeremonyAttesterRegistry)
//   message CeremonyAttestation(address account, bytes32 action,
//           bytes32 newKeyHash, bytes32 partnerId, uint256 nonce,
//           uint48 notBefore, uint48 expiry)
//
// The domain names the registry, never the account, and the account is in
// the message, so an attestation never replays across accounts. The signature
// recovers over the digest directly (no EIP-191 prefix). Accounts of Base
// Sepolia's deployed generation verify EIP-191 over an earlier hash; the SDK
// has no code for that form (the attester alone carries it until that
// generation retires). The shared fixture `test/fixtures/ceremonyTypes.json`
// pins the type string, the typehash and digests and signatures from fixed
// keys, for the account contract's, the attester's and the plane's tests.
import { getAddress, hexlify, id, isHexString, recoverAddress, SigningKey, TypedDataEncoder, } from 'ethers';
/** The ceremony domain's `name`. */
export const CEREMONY_DOMAIN_NAME = 'Cofferdam Ceremony';
/** The ceremony domain's `version`. */
export const CEREMONY_DOMAIN_VERSION = '1';
/** The one primary type a ceremony attester signs. */
export const CEREMONY_PRIMARY_TYPE = 'CeremonyAttestation';
/** The EIP-712 types of a ceremony attestation, in the contract's field order. */
export const CEREMONY_TYPES = Object.freeze({
    CeremonyAttestation: Object.freeze([
        { name: 'account', type: 'address' },
        { name: 'action', type: 'bytes32' },
        { name: 'newKeyHash', type: 'bytes32' },
        { name: 'partnerId', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'notBefore', type: 'uint48' },
        { name: 'expiry', type: 'uint48' },
    ]),
});
/** `CeremonyAttestation(address account,bytes32 action,...)`. */
export const CEREMONY_TYPE_STRING = 'CeremonyAttestation(address account,bytes32 action,bytes32 newKeyHash,bytes32 partnerId,uint256 nonce,uint48 notBefore,uint48 expiry)';
/** `CofferdamAccount4337.CEREMONY_TYPEHASH`. */
export const CEREMONY_TYPEHASH = id(CEREMONY_TYPE_STRING);
/** The ceremony actions, as `CofferdamAccount4337.ACTION_*` hash them. */
export const CEREMONY_ACTIONS = Object.freeze({
    'enroll-first-high': id('enroll-first-high'),
    'replace-partner': id('replace-partner'),
    'recover-high': id('recover-high'),
});
const UINT48_MAX = (1n << 48n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
/**
 * The ceremony domain for a generation.
 *
 * @param chainId - Base (8453) or Base Sepolia (84532).
 * @param registry - That generation's `CofferdamCeremonyAttesterRegistry`, from the caller's configuration.
 */
export function ceremonyDomain(chainId, registry) {
    return {
        name: CEREMONY_DOMAIN_NAME,
        version: CEREMONY_DOMAIN_VERSION,
        chainId: BigInt(chainId),
        verifyingContract: getAddress(registry),
    };
}
function checkDomain(domain) {
    if (domain.name !== CEREMONY_DOMAIN_NAME ||
        domain.version !== CEREMONY_DOMAIN_VERSION ||
        domain.chainId === undefined ||
        domain.chainId === null ||
        !domain.verifyingContract ||
        domain.salt !== undefined) {
        throw new Error('not the ceremony domain: use ceremonyDomain(chainId, registry)');
    }
}
function word(value, field) {
    if (!isHexString(value, 32))
        throw new Error(`${field} must be 32 bytes of 0x hex`);
    return value.toLowerCase();
}
function uint(value, field, max) {
    if (typeof value !== 'bigint' || value < 0n || value > max)
        throw new Error(`${field} out of range`);
    return value;
}
/** The message with every field checked and normalised; throws on a bad one. */
export function checkCeremonyMessage(message) {
    const out = {
        account: getAddress(message.account),
        action: word(message.action, 'action'),
        newKeyHash: word(message.newKeyHash, 'newKeyHash'),
        partnerId: word(message.partnerId, 'partnerId'),
        nonce: uint(message.nonce, 'nonce', UINT256_MAX),
        notBefore: uint(message.notBefore, 'notBefore', UINT48_MAX),
        expiry: uint(message.expiry, 'expiry', UINT48_MAX),
    };
    if (!Object.values(CEREMONY_ACTIONS).includes(out.action))
        throw new Error('action is not a ceremony action');
    if (out.expiry <= out.notBefore)
        throw new Error('expiry must be after notBefore');
    return out;
}
function types() {
    return { CeremonyAttestation: [...CEREMONY_TYPES.CeremonyAttestation] };
}
/**
 * The EIP-712 digest of a ceremony attestation: what the attester signs and
 * what `CofferdamAccount4337.ceremonyHash` returns.
 *
 * @returns 0x-prefixed 32 bytes.
 */
export function ceremonyDigest(domain, message) {
    checkDomain(domain);
    return TypedDataEncoder.hash(domain, types(), checkCeremonyMessage(message));
}
/**
 * Sign a ceremony attestation with a secp256k1 key. Test fixtures and local
 * networks only: the attester signs in its own Worker, so this is not
 * exported from the package's entry point.
 *
 * @internal
 *
 * @returns The 65-byte signature r ‖ s ‖ v (v 27 or 28, low s), 0x hex.
 */
export function signCeremonyAttestation(privateKey, domain, message) {
    return new SigningKey(hexlify(privateKey)).sign(ceremonyDigest(domain, message)).serialized;
}
/**
 * The address that signed a ceremony attestation, or null for a malformed
 * signature. The caller compares it with the registry's `isTrustedAttester`;
 * the address alone proves nothing.
 */
export function recoverCeremonySigner(domain, message, signature) {
    const digest = ceremonyDigest(domain, message);
    try {
        return recoverAddress(digest, signature);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=ceremony.js.map