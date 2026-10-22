// Pseudonym + scope-key derivation using HKDF (RFC 5869).
//
// Implements the construction from cofferdam-sdk/README.md §5.6:
//
//   appPseudonym(user, app) = HKDF-Extract(salt=scopeSalt[app], IKM=nullifier(user))
//                             then HKDF-Expand(PRK, info=domain-sep, L=12 bytes)
//
// HKDF provides proper extract-then-expand semantics: the extract phase
// concentrates entropy from the nullifier into a pseudo-random key (PRK)
// keyed by the per-app scopeSalt, and the expand phase domain-separates
// the output. This is structurally stronger than concatenation + hash
// because the salt and IKM serve distinct cryptographic roles rather than
// being mixed into a single digest input.
//
// The wire-level output format (`cd_pseudo_<24-hex>`) is stable across
// the v0.x → v1 upgrade boundary for mock/local/testnet deployments that
// re-derive on first login after the upgrade.
//
// Pure JavaScript (`@noble/hashes`), so it runs identically in browsers,
// Node and React Native: Hermes ships no WebCrypto, and the earlier
// `crypto.subtle` version threw inside `signIn` on a real phone before the
// passkey prompt (2026-10-15).
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
const PSEUDONYM_DOMAIN_SEP = 'cofferdam-pseudonym-v1';
const SCOPEKEY_DOMAIN_SEP = 'cofferdam-scopekey-v1';
/**
 * HKDF-Extract-then-Expand (RFC 5869), HMAC-SHA-256.
 *
 * @param salt - Salt for the extract phase (per-app scopeSalt or scope id)
 * @param ikm  - Input key material (user nullifier or master seed)
 * @param info - Context / domain-separation string for the expand phase
 * @param byteLength - Number of output bytes
 */
async function hkdf(salt, ikm, info, byteLength) {
    return nobleHkdf(sha256, utf8ToBytes(ikm), utf8ToBytes(salt), utf8ToBytes(info), byteLength);
}
function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}
/**
 * Derive a per-app pseudonym for a user.
 *
 * @param scopeSalt - Per-consumer-app constant assigned by Cofferdam at
 *                   integration-onboarding time. In α-1 mock mode, this is
 *                   derived locally from the scope string; in production the
 *                   real scopeSalt is provisioned by the Cofferdam backend.
 * @param nullifier - The user's Cofferdam nullifier. Never leaves the user's
 *                   device.
 * @returns `cd_pseudo_<24-hex>` — 12 bytes / 96 bits of pseudonym, sufficient
 *          for global uniqueness across the realistic user count of any one
 *          consumer app.
 */
export async function derivePseudonym(scopeSalt, nullifier) {
    const derived = await hkdf(scopeSalt, nullifier, PSEUDONYM_DOMAIN_SEP, 12);
    return `cd_pseudo_${bytesToHex(derived)}`;
}
/**
 * Derive the per-consumer-app encryption sub-key. See README §5.2.
 *
 * @param masterSeed - The user's Cofferdam master seed (in α-1 mock mode,
 *                    derived from the mock user identifier; in production,
 *                    derived from the smart-account root key).
 * @param scope - The consumer app's registered scope identifier.
 * @returns `cdsk_<64-hex>` — 32 bytes / 256 bits of sub-key material.
 */
export async function deriveScopeKey(masterSeed, scope) {
    const derived = await hkdf(scope, masterSeed, SCOPEKEY_DOMAIN_SEP, 32);
    return `cdsk_${bytesToHex(derived)}`;
}
//# sourceMappingURL=pseudonym.js.map