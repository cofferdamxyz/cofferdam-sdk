// P-256 (secp256r1) passkey signing for the Base ERC-4337 Account
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
import { p256 } from '@noble/curves/p256';
import { AbiCoder, concat, getBytes, hexlify } from 'ethers';
const abi = AbiCoder.defaultAbiCoder();
/** `abi.encode(bytes32 qx, bytes32 qy)` — the `PasskeyAuthority` config blob. */
export function encodePasskeyConfig(pub) {
    return abi.encode(['bytes32', 'bytes32'], [pub.qx, pub.qy]);
}
/** Derive the uncompressed P-256 public key coordinates from a private scalar. */
export function p256PublicKey(privateKey) {
    const pub = p256.getPublicKey(privateKey, false); // 0x04 || x(32) || y(32)
    return { qx: hexlify(pub.slice(1, 33)), qy: hexlify(pub.slice(33, 65)) };
}
/**
 * Produce a 64-byte `r || s` P-256 signature over a 32-byte digest, with s
 * forced into the lower half-order. We normalise s explicitly rather than rely
 * on a library default so the output is correct regardless of the bundled
 * `@noble/curves` build (matches contracts/test/helpers/authority.ts).
 */
export function signP256Digest(privateKey, digest) {
    const sig = p256.sign(digest, privateKey);
    const n = p256.CURVE.n;
    let s = sig.s;
    if (s > n / 2n)
        s = n - s;
    const r = sig.r.toString(16).padStart(64, '0');
    const sHex = s.toString(16).padStart(64, '0');
    return '0x' + r + sHex;
}
/**
 * Verify a raw 64-byte `r || s` P-256 signature (as produced by
 * `signP256Digest`) over a 32-byte `digest` against `pub`. The inverse
 * predicate of `signP256Digest`; mirrors the on-chain `PasskeyAuthority` check.
 * Returns false (never throws) on any malformed input.
 */
export function verifyP256Digest(pub, digest, signature) {
    try {
        const sig = getBytes(signature);
        const point = getBytes(concat(['0x04', pub.qx, pub.qy]));
        return p256.verify(sig, digest, point);
    }
    catch {
        return false;
    }
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
export class DeterministicPasskeySigner {
    userId;
    seed;
    scheme = 'p256';
    cached = null;
    constructor(userId, seed = 'cofferdam-native-passkey-v1') {
        this.userId = userId;
        this.seed = seed;
    }
    async privateKey() {
        if (!this.cached) {
            this.cached = await hmacSha256(this.seed, this.userId);
        }
        return this.cached;
    }
    async publicKey() {
        return p256PublicKey(await this.privateKey());
    }
    async sign(digest) {
        return signP256Digest(await this.privateKey(), getBytes(digest));
    }
}
async function hmacSha256(salt, input) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('[cofferdam-sdk] SubtleCrypto unavailable. Need Node >=19, a modern browser, ' +
            'or a React Native webcrypto polyfill.');
    }
    const key = await subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await subtle.sign('HMAC', key, new TextEncoder().encode(input));
    return new Uint8Array(sig);
}
//# sourceMappingURL=passkey.js.map