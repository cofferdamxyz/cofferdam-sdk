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
// Runs identically in browsers (modern WebView), React Native (via the
// react-native-web-crypto polyfill in α-2+), and Node >=19 (built-in
// globalThis.crypto.subtle).

const PSEUDONYM_DOMAIN_SEP = 'cofferdam-pseudonym-v1'
const SCOPEKEY_DOMAIN_SEP = 'cofferdam-scopekey-v1'

function getSubtle(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw new Error(
      '[cofferdam-sdk] SubtleCrypto not available. Need Node >=19 or a modern browser. ' +
        'For React Native, install a webcrypto polyfill (lands as a dep in @cofferdam/sdk-react-native).',
    )
  }
  return subtle
}

/**
 * HKDF-Extract-then-Expand (RFC 5869) via Web Crypto API.
 *
 * @param salt - Salt for the extract phase (per-app scopeSalt or scope id)
 * @param ikm  - Input key material (user nullifier or master seed)
 * @param info - Context / domain-separation string for the expand phase
 * @param byteLength - Number of output bytes
 */
async function hkdf(
  salt: string,
  ikm: string,
  info: string,
  byteLength: number,
): Promise<Uint8Array> {
  const subtle = getSubtle()
  const encoder = new TextEncoder()

  const keyMaterial = await subtle.importKey(
    'raw',
    encoder.encode(ikm) as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  )

  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(salt) as BufferSource,
      info: encoder.encode(info) as BufferSource,
    },
    keyMaterial,
    byteLength * 8,
  )

  return new Uint8Array(bits)
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0')
  }
  return out
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
export async function derivePseudonym(
  scopeSalt: string,
  nullifier: string,
): Promise<string> {
  const derived = await hkdf(scopeSalt, nullifier, PSEUDONYM_DOMAIN_SEP, 12)
  return `cd_pseudo_${bytesToHex(derived)}`
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
export async function deriveScopeKey(
  masterSeed: string,
  scope: string,
): Promise<string> {
  const derived = await hkdf(scope, masterSeed, SCOPEKEY_DOMAIN_SEP, 32)
  return `cdsk_${bytesToHex(derived)}`
}
