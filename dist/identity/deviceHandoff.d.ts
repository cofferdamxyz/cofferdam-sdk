import type { P256PublicKey, PasskeySigner } from './passkey.js';
/** Wire-format version of the device-handoff payload. */
export declare const DEVICE_HANDOFF_VERSION = 1;
/** Upper bound on a human device label, so a QR stays scannable. */
export declare const MAX_DEVICE_LABEL_LENGTH = 64;
/** Default freshness window: a scanned QR older than this is rejected. */
export declare const DEFAULT_HANDOFF_MAX_AGE_MS: number;
/** The fields the new device commits to (everything but the version + signature). */
export interface DeviceHandoffFields {
    /** base64url WebAuthn credential id of the new device's passkey. */
    credentialId: string;
    /** The new passkey's P-256 public key — becomes the account authority config. */
    publicKey: P256PublicKey;
    /** Human-readable device label, e.g. "Pixel 7" / "Mevlüt's iPad". */
    label: string;
    /** Unix epoch milliseconds when the QR was generated (replay bound). */
    ts: number;
    /** The new device's own counterfactual AA address (binds the proof to it). */
    deviceAccount: string;
}
/** A full, self-contained device-handoff payload (the QR content, decoded). */
export interface DeviceHandoff extends DeviceHandoffFields {
    v: number;
    /** WebAuthn assertion (abi.encode(WebAuthnAuth)) over `deviceHandoffDigest`. */
    livenessSig: string;
}
/** Base class for every device-handoff failure. */
export declare class DeviceHandoffError extends Error {
    constructor(message: string);
}
/** The scanned token was not a well-formed Cofferdam handoff payload. */
export declare class DeviceHandoffDecodeError extends DeviceHandoffError {
}
/** The QR is older than `maxAgeMs` (or clock-skewed into the future). */
export declare class DeviceHandoffExpiredError extends DeviceHandoffError {
}
/** The liveness proof failed: the QR was not signed by the presented passkey. */
export declare class DeviceHandoffLivenessError extends DeviceHandoffError {
}
/**
 * The 32-byte digest the new device signs (and the canonical device recomputes).
 * Commits to a domain separator + every handoff field, so tampering any field
 * breaks the WebAuthn challenge match.
 */
export declare function deviceHandoffDigest(f: DeviceHandoffFields): Uint8Array;
/**
 * Build a signed handoff payload on the NEW device. Prompts the passkey (the
 * injected `signer` performs the WebAuthn assertion over the digest, gating on
 * biometric in production). The signer's public key is used unless `publicKey`
 * is supplied explicitly.
 */
export declare function createDeviceHandoff(args: {
    signer: PasskeySigner;
    credentialId: string;
    label: string;
    deviceAccount: string;
    publicKey?: P256PublicKey;
    ts?: number;
}): Promise<DeviceHandoff>;
/** Serialize a handoff payload into a compact, prefixed QR token. */
export declare function encodeDeviceHandoff(handoff: DeviceHandoff): string;
/**
 * Parse a scanned QR token into a structurally-valid `DeviceHandoff`. Throws
 * `DeviceHandoffDecodeError` on any malformation. Does NOT verify the liveness
 * proof — call `verifyDeviceHandoff` (or `decodeAndVerifyDeviceHandoff`).
 */
export declare function decodeDeviceHandoff(token: string): DeviceHandoff;
/**
 * Verify a decoded handoff: freshness (`maxAgeMs`, set 0 to skip) + the WebAuthn
 * liveness proof that the presented passkey signed exactly these fields. Throws
 * `DeviceHandoffExpiredError` / `DeviceHandoffLivenessError` on failure.
 */
export declare function verifyDeviceHandoff(handoff: DeviceHandoff, opts?: {
    maxAgeMs?: number;
    now?: number;
}): void;
/** Convenience: decode + verify in one call, returning the trusted payload. */
export declare function decodeAndVerifyDeviceHandoff(token: string, opts?: {
    maxAgeMs?: number;
    now?: number;
}): DeviceHandoff;
//# sourceMappingURL=deviceHandoff.d.ts.map