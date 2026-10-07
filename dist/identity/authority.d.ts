import type { AuthorityKind, AuthorityState, AuthorityTier, DeviceCapability, EnrollmentLane, MigrationStatus, PasskeyUpgradeDirective, SignInResponse } from '../types.js';
/** Map an authority kind to its tier. */
export declare function tierOf(kind: AuthorityKind): AuthorityTier;
/** A leakable credential whose upgrade path is the one-way ratchet (§2.5.2). */
export declare function isUntrustedLowTier(kind: AuthorityKind): boolean;
/**
 * Conservative default: assume no platform authenticator and no reachable RN
 * app. With these defaults `chooseEnrollmentLane` returns null, so a provider
 * that does not report capabilities forces the consumer down the
 * install-the-app path rather than silently minting a weak in-browser key.
 */
export declare const DEFAULT_DEVICE_CAPABILITY: DeviceCapability;
export interface LanePolicy {
    /** See SignInPolicy.allowInBrowserPasskey. */
    allowInBrowserPasskey?: boolean;
}
/**
 * Pick the first-passkey enrolment lane.
 *
 * The QR handoff to the Cofferdam RN app is the default, canonical lane (its
 * Secure-Enclave passkey is hardware-bound and portable). An in-browser
 * platform-authenticator passkey is used only when the consumer has opted in
 * AND the device can do it AND the RN app is not reachable. Returns `null` when
 * no viable lane exists ⇒ the consumer must route the user to install the
 * Cofferdam app.
 */
export declare function chooseEnrollmentLane(capability: DeviceCapability, policy?: LanePolicy): EnrollmentLane | null;
/** Base class for every passkey-upgrade failure. */
export declare class PasskeyUpgradeError extends Error {
    constructor(message: string);
}
/** The one-way ratchet already fired; the low-tier authority is locked out. */
export declare class UpgradePathLockedError extends PasskeyUpgradeError {
    constructor(message?: string);
}
/** The active authority is already a high-tier passkey — nothing to upgrade. */
export declare class AlreadyHighTierError extends PasskeyUpgradeError {
    constructor(message?: string);
}
/**
 * A managed (Polis SSO) authority cannot use the consumer ratchet. It upgrades
 * via the enterprise addAuthority OR-semantics path (§3.10), not here.
 */
export declare class ManagedAuthorityNotUpgradableError extends PasskeyUpgradeError {
    constructor(message?: string);
}
/** No viable enrolment lane on this surface (no app + no in-browser passkey). */
export declare class PasskeyUpgradeUnsupportedError extends PasskeyUpgradeError {
    constructor(message?: string);
}
/**
 * Guard the first-passkey enrolment. Throws when the AA is not in a state where
 * an untrusted low-tier authority may enrol the first passkey:
 * - `AlreadyHighTierError`              — the active authority is already a passkey.
 * - `ManagedAuthorityNotUpgradableError`— the active authority is Polis SSO.
 * - `UpgradePathLockedError`            — a passkey already exists (ratchet fired).
 */
export declare function assertCanEnrollFirstPasskey(state: AuthorityState): void;
/**
 * Decide whether/how to nudge the user toward a passkey, given the current
 * authority state, device capability, and consumer policy. Returns `null` when
 * there is nothing to do.
 *
 * - High tier with a single passkey ⇒ recommend (not require) a backup device.
 * - Managed low tier (Polis SSO)    ⇒ `null` (handled by the enterprise path).
 * - Untrusted low tier, no passkey  ⇒ require the first-passkey enrolment.
 * - Untrusted low tier, ratchet fired ⇒ `null` (a passkey already governs the AA).
 */
export declare function evaluateUpgrade(state: AuthorityState, capability?: DeviceCapability, policy?: LanePolicy): PasskeyUpgradeDirective | null;
/**
 * Synthesize an `AuthorityState` from a `SignInResponse` for providers that
 * report `authority` on the response but do not implement `getAuthorityState`.
 * Falls back to conservative defaults derived from the authority tier.
 */
export declare function authorityStateFromResponse(response: SignInResponse): AuthorityState;
export type MigrationEvent = 'passkey_enrolled' | 'declined' | 'reset';
/**
 * Advance the consumer-side `migrationStatus`. Enrolment is terminal: once
 * `enrolled`, neither `declined` nor `reset` can move it backward.
 */
export declare function nextMigrationStatus(current: MigrationStatus, event: MigrationEvent): MigrationStatus;
//# sourceMappingURL=authority.d.ts.map