// secp256k1 "session key" authority — the LEGACY-AUTH BRIDGE.
//
// This is the off-chain mirror of the on-chain `SessionKeyAuthority`
// (base-contracts/contracts/auth/SessionKeyAuthority.sol). It is the single
// mechanism that lets any consumer app already running on a non-passkey auth
// method — a local password, Google / Apple OAuth, or a Polis SSO JWT — map
// that web2 login onto a Base ERC-4337 smart account, with no seed phrase and
// no change to the account ABI.
//
// HOW THE MAPPING WORKS (IDENTITY_LAYER_DESIGN.md §2.5 / §3.12):
//   1. The consumer's server authenticates the user the way it always has
//      (password check, OAuth code exchange, OIDC ID-token).
//   2. The server holds a per-account ECDSA "session signer" key and registers
//      its ADDRESS as the account's authority `config = abi.encode(address)`.
//   3. To authorise an account action, the server signs the account's digest
//      (userOpHash) with that key, domain-bound to the account so a signature
//      for one account can never be replayed against another.
// The chain verifies the vouch cheaply (one `ecrecover`) — the same trust class
// as the Self.xyz bind attester. Deployed at `Tier.LowUntrusted` the bridge can
// ONLY enrol the first passkey (then the one-way ratchet locks it out); at
// `Tier.LowManaged` (Polis SSO) it coexists with a later passkey.
import { AbiCoder, getBytes, keccak256, toUtf8Bytes, Wallet as EthWallet } from 'ethers';
const abi = AbiCoder.defaultAbiCoder();
/** `abi.encode(address sessionSigner)` — the `SessionKeyAuthority` config blob. */
export function encodeSessionConfig(sessionSigner) {
    return abi.encode(['address'], [sessionSigner]);
}
/**
 * Produce the `SessionKeyAuthority` inner signature over `digest`, domain-bound
 * to `account`. Matches the contract exactly:
 *   ecrecover(personal_sign(keccak256(abi.encode(account, digest)))) == signer
 * Returns a 0x-prefixed 65-byte `r || s || v` hex string (v ∈ {27,28}).
 */
export async function signSessionInner(signer, account, digest) {
    const bound = keccak256(abi.encode(['address', 'bytes32'], [account, digest]));
    // ethers `signMessage(bytes)` applies the `\x19Ethereum Signed Message:\n32`
    // prefix and signs — i.e. EIP-191 personal_sign of the 32-byte `bound`.
    return signer.signMessage(getBytes(bound));
}
/**
 * Deterministically derive a server-held session signer for a `(scope,
 * credential)` pair. This MODELS what a consumer's backend does after it
 * authenticates a web2 login: mint/look-up a stable per-account ECDSA key.
 *
 * SECURITY: deterministic so the SAME login reproduces the SAME on-chain
 * account address (essential for counterfactual addressing, demos, and tests).
 * A production server MUST instead store a random key in a vault / HSM and look
 * it up by the authenticated user id — never derive it from the credential.
 */
export function deriveSessionSigner(scope, credential, serverSecret = 'cofferdam-demo-server-secret') {
    const sk = keccak256(toUtf8Bytes(`cofferdam-session-signer|${serverSecret}|${scope}|${credential}`));
    return new EthWallet(sk);
}
//# sourceMappingURL=sessionKey.js.map