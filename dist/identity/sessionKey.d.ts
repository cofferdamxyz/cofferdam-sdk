import { Wallet as EthWallet } from 'ethers';
/**
 * The minimal signing seam the session-key lane needs. An ethers `Wallet`
 * satisfies it, as does any server-side signer / KMS wrapper that can produce
 * an EIP-191 `personal_sign` over a 32-byte digest.
 */
export interface SessionSigner {
    getAddress(): Promise<string>;
    signMessage(message: string | Uint8Array): Promise<string>;
}
/** `abi.encode(address sessionSigner)` — the `SessionKeyAuthority` config blob. */
export declare function encodeSessionConfig(sessionSigner: string): string;
/**
 * Produce the `SessionKeyAuthority` inner signature over `digest`, domain-bound
 * to `account`. Matches the contract exactly:
 *   ecrecover(personal_sign(keccak256(abi.encode(account, digest)))) == signer
 * Returns a 0x-prefixed 65-byte `r || s || v` hex string (v ∈ {27,28}).
 */
export declare function signSessionInner(signer: SessionSigner, account: string, digest: string): Promise<string>;
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
export declare function deriveSessionSigner(scope: string, credential: string, serverSecret?: string): EthWallet;
//# sourceMappingURL=sessionKey.d.ts.map