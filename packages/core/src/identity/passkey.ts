// P-256 (secp256r1) passkey signing for the native ZKSync Era Account
// Abstraction stack.
//
// The on-chain `PasskeyAuthority` module (contracts/v2/auth/authorities/
// PasskeyAuthority.sol) is a High-tier authority that verifies a RAW P-256
// signature over a 32-byte digest:
//   - config    = abi.encode(bytes32 qx, bytes32 qy)  — the public key.
//   - signature = 64 bytes r || s, with s normalised to the lower half-order
//                 (OpenZeppelin `P256.verify` rejects high-s per EIP-2).
//
// This module mirrors that scheme exactly so a signature produced here verifies
// on-chain. The `PasskeySigner` interface is the extensibility seam: today the
// default is a deterministic, software-held key (PoC parity with
// `LocalChainProvider`'s deterministic EOA), and a real platform/WebAuthn
// authenticator (Secure Enclave / StrongBox via `react-native-passkeys`, or
// `navigator.credentials` in the browser) drops in behind the same interface
// without the provider or contracts changing.

import { p256 } from '@noble/curves/p256'
import { AbiCoder, getBytes, hexlify } from 'ethers'

const abi = AbiCoder.defaultAbiCoder()

/** A P-256 public key as two 0x-prefixed 32-byte hex coordinates. */
export interface P256PublicKey {
  /** Affine x coordinate (`qx`). */
  qx: string
  /** Affine y coordinate (`qy`). */
  qy: string
}

/**
 * The signing seam for the native AA passkey authority. Implementations hold
 * (or gate access to) a P-256 private key and produce raw `r || s` signatures
 * over the account's transaction digest.
 */
export interface PasskeySigner {
  /** The P-256 public key, used to build the on-chain authority `config`. */
  publicKey(): Promise<P256PublicKey>
  /**
   * Sign a 32-byte `digest`, returning a 0x-prefixed 64-byte `r || s` hex
   * string with low-s normalisation (as `PasskeyAuthority` requires).
   */
  sign(digest: Uint8Array): Promise<string>
}

/** `abi.encode(bytes32 qx, bytes32 qy)` — the `PasskeyAuthority` config blob. */
export function encodePasskeyConfig(pub: P256PublicKey): string {
  return abi.encode(['bytes32', 'bytes32'], [pub.qx, pub.qy])
}

/** Derive the uncompressed P-256 public key coordinates from a private scalar. */
export function p256PublicKey(privateKey: Uint8Array): P256PublicKey {
  const pub = p256.getPublicKey(privateKey, false) // 0x04 || x(32) || y(32)
  return { qx: hexlify(pub.slice(1, 33)), qy: hexlify(pub.slice(33, 65)) }
}

/**
 * Produce a 64-byte `r || s` P-256 signature over a 32-byte digest, with s
 * forced into the lower half-order. We normalise s explicitly rather than rely
 * on a library default so the output is correct regardless of the bundled
 * `@noble/curves` build (matches contracts/test/helpers/authority.ts).
 */
export function signP256Digest(privateKey: Uint8Array, digest: Uint8Array): string {
  const sig = p256.sign(digest, privateKey)
  const n = p256.CURVE.n
  let s = sig.s
  if (s > n / 2n) s = n - s
  const r = sig.r.toString(16).padStart(64, '0')
  const sHex = s.toString(16).padStart(64, '0')
  return '0x' + r + sHex
}

/**
 * Deterministic, software-held P-256 signer. PoC-only: the private key is
 * derived as HMAC-SHA256(seed, userId) so a given (seed, userId) always yields
 * the same passkey — keeping counterfactual addresses and fixtures byte-stable
 * across runs, exactly like `LocalChainProvider`'s deterministic EOA.
 *
 * SECURITY: predictable to anyone who knows `seed` + `userId`. Never use for an
 * account holding real funds; swap in a hardware/WebAuthn `PasskeySigner` for
 * anything beyond local PoC.
 */
export class DeterministicPasskeySigner implements PasskeySigner {
  private cached: Uint8Array | null = null

  constructor(
    private readonly userId: string,
    private readonly seed = 'cofferdam-native-passkey-v1',
  ) {}

  private async privateKey(): Promise<Uint8Array> {
    if (!this.cached) {
      this.cached = await hmacSha256(this.seed, this.userId)
    }
    return this.cached
  }

  async publicKey(): Promise<P256PublicKey> {
    return p256PublicKey(await this.privateKey())
  }

  async sign(digest: Uint8Array): Promise<string> {
    return signP256Digest(await this.privateKey(), getBytes(digest))
  }
}

async function hmacSha256(salt: string, input: string): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw new Error(
      '[cofferdam-sdk] SubtleCrypto unavailable. Need Node >=19, a modern browser, ' +
        'or a React Native webcrypto polyfill.',
    )
  }
  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(salt) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await subtle.sign('HMAC', key, new TextEncoder().encode(input) as BufferSource)
  return new Uint8Array(sig)
}
