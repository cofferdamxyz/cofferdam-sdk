// Air-gapped device-handoff QR payload (`cdh1:`) for the two-QR device link —
// workspace `docs/architecture/identity.md`.
//
// The NEW device renders a QR encoding its passkey public key + a liveness
// proof-of-possession; a LINKED (canonical) device scans it, verifies the
// proof, reviews the label, and submits `addAuthority`
// (`NativeAccountProvider.addBackupPasskey`) to register the new passkey on the
// shared account. This is the same primitive Cofferdam uses for offline,
// same-room device adds with no network.
//
// Payload (per §3.6.4 Step A):
//   (credentialId, pubKeyX, pubKeyY, deviceLabel, ts, deviceAccount, livenessSig)
//
// `livenessSig` is the new device's passkey signing the handoff DIGEST — a real
// WebAuthn assertion whose `challenge` equals that digest. The digest commits to
// EVERY field, so a scanned QR cannot be tampered (label/key/account) without
// invalidating the proof. `ts` bounds replay: a canonical device rejects a QR
// older than `maxAgeMs`.
//
// The flow is WebAuthn-native: `livenessSig` is an `abi.encode(WebAuthnAuth)`
// blob (what `WebAuthnPasskeySigner.sign` returns), verified off-chain by
// `verifyWebAuthnAssertion` — the same scheme the on-chain
// `WebAuthnPasskeyAuthority` enforces.
//
// Version 2 (workspace decision 0081, step 5) adds `handoverKey`, the new
// device's X25519 public key, so the linked device can seal the account's Vault
// and messaging roots to it after the authority lands. A v2 digest uses its own
// domain and a fixed layout that always carries the invitation challenge and
// the handover key: under the v1 layout, where the challenge is appended only
// when present and `v` is not signed, a v2 handoff with no challenge and a
// handover key K would encode to the same bytes as a v1 handoff with challenge
// K. The v1 digest is unchanged, so v1 tokens from older apps still verify; an
// older app refuses a v2 token at decode.
import { AbiCoder, getBytes, keccak256 } from 'ethers';
import { base64urlToBytes, bytesToBase64url, verifyWebAuthnAssertion } from './webauthn.js';
const abi = AbiCoder.defaultAbiCoder();
/** Wire-format version of the newest device-handoff payload this SDK creates. */
export const DEVICE_HANDOFF_VERSION = 2;
/** Token prefix so a scanner can cheaply reject non-Cofferdam QRs. */
const PREFIX = 'cdh1:';
/** Domain separator mixed into the signed v1 digest. */
const DIGEST_DOMAIN = 'cofferdam-device-handoff-v1';
/** Domain separator of the v2 digest, so no v2 encoding can equal a v1 one. */
const DIGEST_DOMAIN_V2 = 'cofferdam-device-handoff-v2';
/** Upper bound on a human device label, so a QR stays scannable. */
export const MAX_DEVICE_LABEL_LENGTH = 64;
/** Default freshness window: a scanned QR older than this is rejected. */
export const DEFAULT_HANDOFF_MAX_AGE_MS = 5 * 60_000;
/** Allowance for the new device's clock running slightly ahead of the scanner. */
const CLOCK_SKEW_MS = 60_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
/** Base class for every device-handoff failure. */
export class DeviceHandoffError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}
/** The scanned token was not a well-formed Cofferdam handoff payload. */
export class DeviceHandoffDecodeError extends DeviceHandoffError {
}
/** The QR is older than `maxAgeMs` (or clock-skewed into the future). */
export class DeviceHandoffExpiredError extends DeviceHandoffError {
}
/** The liveness proof failed: the QR was not signed by the presented passkey. */
export class DeviceHandoffLivenessError extends DeviceHandoffError {
}
/**
 * The 32-byte digest the new device signs (and the canonical device recomputes).
 * Commits to a domain separator + every handoff field, so tampering any field
 * breaks the WebAuthn challenge match. A `handoverKey` selects the v2 digest,
 * which needs the invitation challenge and encodes both in fixed positions;
 * without one the v1 digest is computed exactly as before.
 */
export function deviceHandoffDigest(f) {
    if (f.handoverKey !== undefined) {
        if (!f.challenge) {
            throw new DeviceHandoffError('[cofferdam-sdk] a v2 handoff needs the invitation challenge.');
        }
        const encoded = abi.encode(['string', 'string', 'bytes32', 'bytes32', 'string', 'uint64', 'address', 'bytes32', 'bytes32'], [
            DIGEST_DOMAIN_V2,
            f.credentialId,
            f.publicKey.qx,
            f.publicKey.qy,
            f.label,
            BigInt(f.ts),
            f.deviceAccount,
            f.challenge,
            f.handoverKey,
        ]);
        return getBytes(keccak256(encoded));
    }
    const types = ['string', 'string', 'bytes32', 'bytes32', 'string', 'uint64', 'address'];
    const values = [
        DIGEST_DOMAIN,
        f.credentialId,
        f.publicKey.qx,
        f.publicKey.qy,
        f.label,
        BigInt(f.ts),
        f.deviceAccount,
    ];
    if (f.challenge) {
        types.push('bytes32');
        values.push(f.challenge);
    }
    const encoded = abi.encode(types, values);
    return getBytes(keccak256(encoded));
}
/** 0x-prefixed 32-byte hex, the shape of an invitation challenge. */
const CHALLENGE_RE = /^0x[0-9a-fA-F]{64}$/;
/**
 * Build a signed handoff payload on the NEW device. Prompts the passkey (the
 * injected `signer` performs the WebAuthn assertion over the digest, gating on
 * biometric in production). The signer's public key is used unless `publicKey`
 * is supplied explicitly. A `handoverKey` makes a v2 handoff and requires the
 * invitation `challenge`; without one the handoff is v1.
 */
export async function createDeviceHandoff(args) {
    const label = args.label.trim();
    if (!label) {
        throw new DeviceHandoffError('[cofferdam-sdk] device handoff requires a non-empty label.');
    }
    if (label.length > MAX_DEVICE_LABEL_LENGTH) {
        throw new DeviceHandoffError(`[cofferdam-sdk] device label exceeds ${MAX_DEVICE_LABEL_LENGTH} characters.`);
    }
    if (!ADDRESS_RE.test(args.deviceAccount)) {
        throw new DeviceHandoffError('[cofferdam-sdk] deviceAccount must be a 20-byte hex address.');
    }
    if (!args.credentialId) {
        throw new DeviceHandoffError('[cofferdam-sdk] device handoff requires a credentialId.');
    }
    if (args.challenge !== undefined && !CHALLENGE_RE.test(args.challenge)) {
        throw new DeviceHandoffError('[cofferdam-sdk] challenge must be 0x-prefixed 32-byte hex.');
    }
    if (args.handoverKey !== undefined) {
        if (!HEX32_RE.test(args.handoverKey)) {
            throw new DeviceHandoffError('[cofferdam-sdk] handoverKey must be 0x-prefixed 32-byte hex.');
        }
        if (!args.challenge) {
            throw new DeviceHandoffError('[cofferdam-sdk] a v2 handoff needs the invitation challenge.');
        }
    }
    const publicKey = args.publicKey ?? (await args.signer.publicKey());
    const ts = args.ts ?? Date.now();
    const fields = {
        credentialId: args.credentialId,
        publicKey,
        label,
        ts,
        deviceAccount: args.deviceAccount,
        ...(args.challenge ? { challenge: args.challenge.toLowerCase() } : {}),
        ...(args.handoverKey !== undefined ? { handoverKey: args.handoverKey.toLowerCase() } : {}),
    };
    const livenessSig = await args.signer.sign(deviceHandoffDigest(fields));
    return { v: fields.handoverKey ? 2 : 1, ...fields, livenessSig };
}
/** Serialize a handoff payload into a compact, prefixed QR token. */
export function encodeDeviceHandoff(handoff) {
    return PREFIX + bytesToBase64url(new TextEncoder().encode(JSON.stringify(handoff)));
}
/**
 * Parse a scanned QR token into a structurally-valid `DeviceHandoff`. Throws
 * `DeviceHandoffDecodeError` on any malformation. Does NOT verify the liveness
 * proof — call `verifyDeviceHandoff` (or `decodeAndVerifyDeviceHandoff`).
 */
export function decodeDeviceHandoff(token) {
    if (typeof token !== 'string' || !token.startsWith(PREFIX)) {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] not a Cofferdam device-handoff token.');
    }
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(token.slice(PREFIX.length))));
    }
    catch {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff payload is not valid base64url JSON.');
    }
    return assertWellFormed(parsed);
}
/**
 * Verify a decoded handoff: freshness (`maxAgeMs`, set 0 to skip) + the WebAuthn
 * liveness proof that the presented passkey signed exactly these fields. Throws
 * `DeviceHandoffExpiredError` / `DeviceHandoffLivenessError` on failure.
 */
export function verifyDeviceHandoff(handoff, opts = {}) {
    // A decoded token already holds this, but a caller can hand in an object it
    // built itself; a mismatch would let `v` claim a version the digest is not.
    if ((handoff.v === 2) !== (handoff.handoverKey !== undefined)) {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff version and handoverKey disagree (v2 carries one, v1 none).');
    }
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_HANDOFF_MAX_AGE_MS;
    const now = opts.now ?? Date.now();
    if (maxAgeMs > 0 && (now - handoff.ts > maxAgeMs || handoff.ts - now > CLOCK_SKEW_MS)) {
        throw new DeviceHandoffExpiredError(`[cofferdam-sdk] device-handoff QR is stale or clock-skewed (ts=${handoff.ts}, now=${now}).`);
    }
    if (!verifyWebAuthnAssertion(handoff.livenessSig, deviceHandoffDigest(handoff), handoff.publicKey)) {
        throw new DeviceHandoffLivenessError('[cofferdam-sdk] device-handoff liveness proof failed: the QR was not signed by the presented passkey.');
    }
}
/** Convenience: decode + verify in one call, returning the trusted payload. */
export function decodeAndVerifyDeviceHandoff(token, opts) {
    const handoff = decodeDeviceHandoff(token);
    verifyDeviceHandoff(handoff, opts);
    return handoff;
}
function assertWellFormed(p) {
    if (!p || typeof p !== 'object') {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff payload is not an object.');
    }
    const o = p;
    if (o.v !== 1 && o.v !== 2) {
        throw new DeviceHandoffDecodeError(`[cofferdam-sdk] unsupported device-handoff version ${String(o.v)} (expected 1 or 2).`);
    }
    const v = o.v;
    if (typeof o.credentialId !== 'string' || o.credentialId.length === 0) {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff credentialId is missing.');
    }
    const pk = o.publicKey;
    if (!pk || typeof pk.qx !== 'string' || typeof pk.qy !== 'string' || !HEX32_RE.test(pk.qx) || !HEX32_RE.test(pk.qy)) {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff publicKey (qx/qy) is malformed.');
    }
    if (typeof o.label !== 'string' || o.label.length === 0 || o.label.length > MAX_DEVICE_LABEL_LENGTH) {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff label is missing or too long.');
    }
    if (typeof o.ts !== 'number' || !Number.isFinite(o.ts) || o.ts <= 0) {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff ts is missing or invalid.');
    }
    if (typeof o.deviceAccount !== 'string' || !ADDRESS_RE.test(o.deviceAccount)) {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff deviceAccount is not an address.');
    }
    if (typeof o.livenessSig !== 'string' || !o.livenessSig.startsWith('0x')) {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff livenessSig is missing.');
    }
    if (o.challenge !== undefined && (typeof o.challenge !== 'string' || !CHALLENGE_RE.test(o.challenge))) {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff challenge is malformed.');
    }
    if (v === 2) {
        if (typeof o.handoverKey !== 'string' || !HEX32_RE.test(o.handoverKey)) {
            throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff v2 handoverKey is missing or malformed.');
        }
        if (typeof o.challenge !== 'string') {
            throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff v2 needs the invitation challenge.');
        }
    }
    else if (o.handoverKey !== undefined) {
        throw new DeviceHandoffDecodeError('[cofferdam-sdk] device-handoff v1 cannot carry a handoverKey.');
    }
    return {
        v,
        credentialId: o.credentialId,
        publicKey: { qx: pk.qx, qy: pk.qy },
        label: o.label,
        ts: o.ts,
        deviceAccount: o.deviceAccount,
        ...(typeof o.challenge === 'string' ? { challenge: o.challenge.toLowerCase() } : {}),
        ...(v === 2 && typeof o.handoverKey === 'string' ? { handoverKey: o.handoverKey.toLowerCase() } : {}),
        livenessSig: o.livenessSig,
    };
}
//# sourceMappingURL=deviceHandoff.js.map