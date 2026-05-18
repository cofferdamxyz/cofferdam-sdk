// Pseudonym + scope-key derivation.
//
// Implements the construction from cofferdam-sdk/README.md §5.6:
//
//   appPseudonym(user, app) = H(scopeSalt[app] || nullifier(user) || domain-sep)
//
// In v0.x (mock + local + testnet phases) the SHA-256 implementation here
// stands in for what will become a more carefully-domain-separated KDF in
// production. The wire-level output format (`cd_pseudo_<24-hex>`) is stable
// and matches the README's example values.
//
// Runs identically in browsers (modern WebView), React Native (via the
// react-native-web-crypto polyfill in α-2+), and Node >=19 (built-in
// globalThis.crypto.subtle).

const PSEUDONYM_DOMAIN_SEP = 'cofferdam-pseudonym-v1'
const SCOPEKEY_DOMAIN_SEP = 'cofferdam-scopekey-v1'

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw new Error(
      '[cofferdam-sdk] SubtleCrypto not available. Need Node >=19 or a modern browser. ' +
        'For React Native, install a webcrypto polyfill (lands as a dep in @cofferdam/sdk-react-native).',
    )
  }
  const hash = await subtle.digest('SHA-256', data as BufferSource)
  return new Uint8Array(hash)
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
  const input = `${scopeSalt}|${nullifier}|${PSEUDONYM_DOMAIN_SEP}`
  const digest = await sha256(new TextEncoder().encode(input))
  return `cd_pseudo_${bytesToHex(digest.slice(0, 12))}`
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
  const input = `${masterSeed}|${scope}|${SCOPEKEY_DOMAIN_SEP}`
  const digest = await sha256(new TextEncoder().encode(input))
  return `cdsk_${bytesToHex(digest)}`
}
