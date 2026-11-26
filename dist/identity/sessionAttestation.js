// Session attestation — a passkey-signed envelope binding a `SignInResponse`.
//
// `NativeAccountProvider.signIn()` returns an `attestation` string so a consumer
// (cofferdam-api, or any relying party) can cryptographically verify that the
// session it received was authorised by the holder of the account's passkey —
// not forged or replayed by a man-in-the-middle that merely observed an
// `appPseudonym` / `accountAddress`.
//
// The attestation commits (via a keccak256 digest the passkey signs) to the
// security-relevant response fields:
//
//   (scope, appPseudonym, accountAddress, chainId, verified, issuedAt) + (qx, qy)
//
// The signing public key (`qx`/`qy`) is carried in the envelope so a verifier
// can check the signature standalone; the verifier is then expected to confirm
// that key is an active authority on `accountAddress` on-chain (the SDK
// `NativeAccountProvider.listAuthorities()` / the on-chain account registry).
//
// Two signature schemes are supported, discriminated by `alg`, matching the two
// `PasskeySigner` implementations:
//   - `'p256'`     — a raw 64-byte `r || s` over the digest (DeterministicPasskeySigner).
//   - `'webauthn'` — an `abi.encode(WebAuthnAuth)` assertion whose WebAuthn
//                    challenge equals the digest (WebAuthnPasskeySigner / a real
//                    Secure-Enclave / StrongBox passkey).
import { AbiCoder, getBytes, keccak256 } from 'ethers';
import { verifyP256Digest, } from './passkey.js';
import { base64urlToBytes, bytesToBase64url, verifyWebAuthnAssertion } from './webauthn.js';
const abi = AbiCoder.defaultAbiCoder();
/** Wire-format version of the session-attestation envelope. */
export const SESSION_ATTESTATION_VERSION = 1;
/** Token prefix so a consumer can cheaply reject non-Cofferdam attestations. */
const PREFIX = 'csa1:';
/** Domain separator mixed into the signed digest (prevents cross-protocol reuse). */
const DIGEST_DOMAIN = 'cofferdam-session-attestation-v1';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
/** Base class for every session-attestation failure. */
export class SessionAttestationError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}
/** The token was not a well-formed Cofferdam session attestation. */
export class SessionAttestationDecodeError extends SessionAttestationError {
}
/** The attestation is older than `maxAgeMs` (or clock-skewed into the future). */
export class SessionAttestationExpiredError extends SessionAttestationError {
}
/** The signature failed, or a presented field did not match `expect`. */
export class SessionAttestationVerificationError extends SessionAttestationError {
}
/**
 * The 32-byte digest the passkey signs (and a verifier recomputes). Commits to a
 * domain separator + every attested field + the signing public key, so tampering
 * any field invalidates the signature (and, for WebAuthn, the challenge match).
 */
export function sessionAttestationDigest(f, publicKey) {
    const encoded = abi.encode(['string', 'string', 'string', 'address', 'uint256', 'bool', 'uint64', 'bytes32', 'bytes32'], [
        DIGEST_DOMAIN,
        f.scope,
        f.appPseudonym,
        f.accountAddress,
        BigInt(f.chainId),
        f.verified,
        BigInt(f.issuedAt),
        publicKey.qx,
        publicKey.qy,
    ]);
    return getBytes(keccak256(encoded));
}
/**
 * Build a signed session attestation. Prompts the passkey (the injected `signer`
 * signs the digest — gating on biometric in production). The signer's public key
 * and scheme are recorded in the envelope so the result verifies standalone.
 */
export async function createSessionAttestation(args) {
    const publicKey = args.publicKey ?? (await args.signer.publicKey());
    const sig = await args.signer.sign(sessionAttestationDigest(args.fields, publicKey));
    return {
        v: SESSION_ATTESTATION_VERSION,
        alg: args.signer.scheme ?? 'p256',
        publicKey,
        ...args.fields,
        sig,
    };
}
/** Serialize an attestation into the compact, prefixed `attestation` token. */
export function encodeSessionAttestation(att) {
    return PREFIX + bytesToBase64url(new TextEncoder().encode(JSON.stringify(att)));
}
/** Convenience: `encodeSessionAttestation(await createSessionAttestation(...))`. */
export async function signSessionAttestation(args) {
    return encodeSessionAttestation(await createSessionAttestation(args));
}
/**
 * Parse an `attestation` token into a structurally-valid `SessionAttestation`.
 * Throws `SessionAttestationDecodeError` on any malformation. Does NOT verify the
 * signature — call `verifySessionAttestation` (or `decodeAndVerifySessionAttestation`).
 */
export function decodeSessionAttestation(token) {
    if (typeof token !== 'string' || !token.startsWith(PREFIX)) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] not a Cofferdam session-attestation token.');
    }
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(token.slice(PREFIX.length))));
    }
    catch {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation payload is not valid base64url JSON.');
    }
    return assertWellFormed(parsed);
}
/**
 * Verify a decoded attestation: optional freshness (`maxAgeMs`, 0 to skip) + the
 * optional `expect` field pins + the passkey signature over exactly these fields.
 * Throws on any failure. On success the payload is trustworthy: the holder of
 * `publicKey` signed precisely this `(scope, appPseudonym, accountAddress, …)`.
 *
 * The caller still owns the on-chain authorisation check — confirm `publicKey`
 * is an active authority on `accountAddress` (e.g. via `listAuthorities()`).
 */
export function verifySessionAttestation(att, opts = {}) {
    const maxAgeMs = opts.maxAgeMs ?? 0;
    const now = opts.now ?? Date.now();
    if (maxAgeMs > 0 && (now - att.issuedAt > maxAgeMs || att.issuedAt - now > 60_000)) {
        throw new SessionAttestationExpiredError(`[cofferdam-sdk] session attestation is stale or clock-skewed (issuedAt=${att.issuedAt}, now=${now}).`);
    }
    const expect = opts.expect;
    if (expect) {
        for (const key of ['scope', 'appPseudonym', 'accountAddress', 'chainId']) {
            const want = expect[key];
            if (want === undefined)
                continue;
            const got = att[key];
            const matches = key === 'accountAddress'
                ? String(got).toLowerCase() === String(want).toLowerCase()
                : got === want;
            if (!matches) {
                throw new SessionAttestationVerificationError(`[cofferdam-sdk] session attestation ${key} mismatch (expected ${String(want)}, got ${String(got)}).`);
            }
        }
    }
    const digest = sessionAttestationDigest(att, att.publicKey);
    const ok = att.alg === 'webauthn'
        ? verifyWebAuthnAssertion(att.sig, digest, att.publicKey)
        : verifyP256Digest(att.publicKey, digest, att.sig);
    if (!ok) {
        throw new SessionAttestationVerificationError('[cofferdam-sdk] session attestation signature failed: not signed by the presented passkey.');
    }
}
/** Convenience: decode + verify in one call, returning the trusted payload. */
export function decodeAndVerifySessionAttestation(token, opts) {
    const att = decodeSessionAttestation(token);
    verifySessionAttestation(att, opts);
    return att;
}
// ── v2: device-bound, tiered, expiring (workspace decision 0055) ─────────────
/** Wire-format version of the device-bound envelope. */
export const SESSION_ATTESTATION_V2 = 2;
/** Domain separator of the v2 digest. */
const DIGEST_DOMAIN_V2 = 'cofferdam-session-attestation-v2';
/** The audience of tokens the Cofferdam plane accepts. */
export const CSA_AUDIENCE_PLANE = 'cofferdam-plane';
/** The longest lifetime a verifier accepts for each tier. */
export const SESSION_TIER_MAX_LIFETIME_MS = {
    fast: 24 * 60 * 60 * 1000,
    slow: 10 * 60 * 1000,
};
const JKT_RE = /^[A-Za-z0-9_-]{43}$/;
/** The 32-byte digest the passkey signs for a v2 envelope. */
export function sessionAttestationV2Digest(f, publicKey) {
    const jkt = base64urlToBytes(f.jkt);
    if (jkt.length !== 32)
        throw new SessionAttestationDecodeError('[cofferdam-sdk] jkt must be a 32-byte thumbprint.');
    const encoded = abi.encode([
        'string', 'string', 'string', 'address', 'uint256', 'bool', 'uint64', 'uint64',
        'string', 'string', 'bytes32', 'bytes32', 'bytes32',
    ], [
        DIGEST_DOMAIN_V2,
        f.scope,
        f.appPseudonym,
        f.accountAddress,
        BigInt(f.chainId),
        f.verified,
        BigInt(f.issuedAt),
        BigInt(f.expiresAt),
        f.aud,
        f.tier,
        jkt,
        publicKey.qx,
        publicKey.qy,
    ]);
    return getBytes(keccak256(encoded));
}
/** Build and sign a v2 envelope. Prompts the passkey (biometric in production). */
export async function createSessionAttestationV2(args) {
    const { jkt, ...rest } = args.fields;
    if (rest.expiresAt - rest.issuedAt > SESSION_TIER_MAX_LIFETIME_MS[rest.tier] || rest.expiresAt <= rest.issuedAt) {
        throw new SessionAttestationVerificationError(`[cofferdam-sdk] a ${rest.tier} session may live at most ${SESSION_TIER_MAX_LIFETIME_MS[rest.tier]} ms.`);
    }
    const publicKey = args.publicKey ?? (await args.signer.publicKey());
    const sig = await args.signer.sign(sessionAttestationV2Digest(args.fields, publicKey));
    return {
        v: SESSION_ATTESTATION_V2,
        alg: args.signer.scheme ?? 'p256',
        publicKey,
        ...rest,
        cnf: { jkt },
        sig,
    };
}
/** Serialize a v2 envelope into its `csa1:` token. */
export function encodeSessionAttestationV2(att) {
    return PREFIX + bytesToBase64url(new TextEncoder().encode(JSON.stringify(att)));
}
/** Convenience: `encodeSessionAttestationV2(await createSessionAttestationV2(...))`. */
export async function signSessionAttestationV2(args) {
    return encodeSessionAttestationV2(await createSessionAttestationV2(args));
}
/** The version of a `csa1:` token (1 or 2), without verifying it. */
export function sessionAttestationVersion(token) {
    if (typeof token !== 'string' || !token.startsWith(PREFIX)) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] not a Cofferdam session-attestation token.');
    }
    try {
        const parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(token.slice(PREFIX.length))));
        const v = parsed !== null && typeof parsed === 'object' ? parsed.v : undefined;
        return typeof v === 'number' ? v : 0;
    }
    catch {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation payload is not valid base64url JSON.');
    }
}
/** Parse a v2 token into a structurally valid envelope. Does not verify it. */
export function decodeSessionAttestationV2(token) {
    if (typeof token !== 'string' || !token.startsWith(PREFIX)) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] not a Cofferdam session-attestation token.');
    }
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(token.slice(PREFIX.length))));
    }
    catch {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation payload is not valid base64url JSON.');
    }
    const o = (parsed ?? {});
    if (o.v !== SESSION_ATTESTATION_V2) {
        throw new SessionAttestationDecodeError(`[cofferdam-sdk] expected a v2 session attestation, got ${String(o.v)}.`);
    }
    const base = assertWellFormed({ ...o, v: SESSION_ATTESTATION_VERSION });
    const cnf = o.cnf;
    if (!cnf || typeof cnf.jkt !== 'string' || !JKT_RE.test(cnf.jkt)) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation cnf.jkt is missing or malformed.');
    }
    if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt) || o.expiresAt <= 0) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation expiresAt is missing or invalid.');
    }
    if (typeof o.aud !== 'string' || o.aud.length === 0) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation aud is missing.');
    }
    if (o.tier !== 'fast' && o.tier !== 'slow') {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation tier must be fast or slow.');
    }
    const { v: _v, ...fields } = base;
    return { v: SESSION_ATTESTATION_V2, ...fields, expiresAt: o.expiresAt, aud: o.aud, tier: o.tier, cnf: { jkt: cnf.jkt } };
}
/**
 * Verify a v2 envelope: lifetime within the tier's cap, not expired, not issued
 * in the future (60 s of skew), the audience, the optional field pins, and the
 * passkey signature. Device possession is checked separately (`verifyPopProof`).
 */
export function verifySessionAttestationV2(att, opts = {}) {
    const now = opts.now ?? Date.now();
    const cap = SESSION_TIER_MAX_LIFETIME_MS[att.tier];
    if (att.expiresAt <= att.issuedAt || att.expiresAt - att.issuedAt > cap) {
        throw new SessionAttestationVerificationError(`[cofferdam-sdk] a ${att.tier} session attestation may live at most ${cap} ms.`);
    }
    if (now >= att.expiresAt || att.issuedAt - now > 60_000) {
        throw new SessionAttestationExpiredError(`[cofferdam-sdk] session attestation is expired or clock-skewed (issuedAt=${att.issuedAt}, expiresAt=${att.expiresAt}, now=${now}).`);
    }
    const audience = opts.audience ?? CSA_AUDIENCE_PLANE;
    if (att.aud !== audience) {
        throw new SessionAttestationVerificationError(`[cofferdam-sdk] session attestation aud mismatch (expected ${audience}, got ${att.aud}).`);
    }
    if (opts.expect) {
        // Reuse v1's field pins; freshness is already checked above.
        const pinned = { ...att, v: SESSION_ATTESTATION_VERSION };
        for (const key of ['scope', 'appPseudonym', 'accountAddress', 'chainId']) {
            const want = opts.expect[key];
            if (want === undefined)
                continue;
            const got = pinned[key];
            const matches = key === 'accountAddress' ? String(got).toLowerCase() === String(want).toLowerCase() : got === want;
            if (!matches) {
                throw new SessionAttestationVerificationError(`[cofferdam-sdk] session attestation ${key} mismatch (expected ${String(want)}, got ${String(got)}).`);
            }
        }
    }
    const digest = sessionAttestationV2Digest({ ...att, jkt: att.cnf.jkt }, att.publicKey);
    const ok = att.alg === 'webauthn'
        ? verifyWebAuthnAssertion(att.sig, digest, att.publicKey)
        : verifyP256Digest(att.publicKey, digest, att.sig);
    if (!ok) {
        throw new SessionAttestationVerificationError('[cofferdam-sdk] session attestation signature failed: not signed by the presented passkey.');
    }
}
/** Convenience: decode + verify a v2 token, returning the trusted envelope. */
export function decodeAndVerifySessionAttestationV2(token, opts) {
    const att = decodeSessionAttestationV2(token);
    verifySessionAttestationV2(att, opts);
    return att;
}
function assertWellFormed(p) {
    if (!p || typeof p !== 'object') {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation payload is not an object.');
    }
    const o = p;
    if (o.v !== SESSION_ATTESTATION_VERSION) {
        throw new SessionAttestationDecodeError(`[cofferdam-sdk] unsupported session-attestation version ${String(o.v)} (expected ${SESSION_ATTESTATION_VERSION}).`);
    }
    if (o.alg !== 'p256' && o.alg !== 'webauthn') {
        throw new SessionAttestationDecodeError(`[cofferdam-sdk] unsupported session-attestation alg ${String(o.alg)}.`);
    }
    const pk = o.publicKey;
    if (!pk || typeof pk.qx !== 'string' || typeof pk.qy !== 'string' || !HEX32_RE.test(pk.qx) || !HEX32_RE.test(pk.qy)) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation publicKey (qx/qy) is malformed.');
    }
    if (typeof o.scope !== 'string' || o.scope.length === 0) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation scope is missing.');
    }
    if (typeof o.appPseudonym !== 'string' || o.appPseudonym.length === 0) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation appPseudonym is missing.');
    }
    if (typeof o.accountAddress !== 'string' || !ADDRESS_RE.test(o.accountAddress)) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation accountAddress is not an address.');
    }
    if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId) || o.chainId <= 0) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation chainId is missing or invalid.');
    }
    if (typeof o.verified !== 'boolean') {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation verified flag is missing.');
    }
    if (typeof o.issuedAt !== 'number' || !Number.isFinite(o.issuedAt) || o.issuedAt <= 0) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation issuedAt is missing or invalid.');
    }
    if (typeof o.sig !== 'string' || !o.sig.startsWith('0x')) {
        throw new SessionAttestationDecodeError('[cofferdam-sdk] session-attestation sig is missing.');
    }
    return {
        v: SESSION_ATTESTATION_VERSION,
        alg: o.alg,
        publicKey: { qx: pk.qx, qy: pk.qy },
        scope: o.scope,
        appPseudonym: o.appPseudonym,
        accountAddress: o.accountAddress,
        chainId: o.chainId,
        verified: o.verified,
        issuedAt: o.issuedAt,
        sig: o.sig,
    };
}
//# sourceMappingURL=sessionAttestation.js.map