// Tiered-authority logic + the one-way upgrade ratchet (rev-7.7).
//
// Pure, I/O-free encoding of cofferdam-sdk/IDENTITY_LAYER_DESIGN.md §2.5 (the
// authority tiers + the ratchet) and §3.12 (the consumer password→passkey
// migration). The on-chain `CofferdamAccountValidator` is the real enforcer
// (contracts/WEB3_CONVERSION.md §3.1); these functions are the client-side
// mirror that decides what the SDK should *do* and guard against obvious
// ratchet violations before a transaction is ever built.
// ── Tier classification ──────────────────────────────────────────────────────
/** Map an authority kind to its tier. */
export function tierOf(kind) {
    switch (kind) {
        case 'passkey':
            return 'high';
        case 'polis_sso':
            return 'low_managed';
        case 'password':
        case 'oauth_google':
        case 'oauth_apple':
            return 'low_untrusted';
    }
}
/** A leakable credential whose upgrade path is the one-way ratchet (§2.5.2). */
export function isUntrustedLowTier(kind) {
    return tierOf(kind) === 'low_untrusted';
}
// ── Device-capability defaults ───────────────────────────────────────────────
/**
 * Conservative default: assume no platform authenticator and no reachable RN
 * app. With these defaults `chooseEnrollmentLane` returns null, so a provider
 * that does not report capabilities forces the consumer down the
 * install-the-app path rather than silently minting a weak in-browser key.
 */
export const DEFAULT_DEVICE_CAPABILITY = {
    hasPlatformAuthenticator: false,
    inBrowserPasskeyReliable: false,
    nativeAppReachable: false,
};
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
export function chooseEnrollmentLane(capability, policy = {}) {
    if (capability.nativeAppReachable)
        return 'qr_handoff';
    const inBrowserOk = !!policy.allowInBrowserPasskey &&
        capability.hasPlatformAuthenticator &&
        capability.inBrowserPasskeyReliable;
    if (inBrowserOk)
        return 'in_browser';
    return null;
}
// ── Ratchet guards ───────────────────────────────────────────────────────────
/** Base class for every passkey-upgrade failure. */
export class PasskeyUpgradeError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}
/** The one-way ratchet already fired; the low-tier authority is locked out. */
export class UpgradePathLockedError extends PasskeyUpgradeError {
    constructor(message = '[cofferdam-sdk] upgrade path is locked: a passkey already exists, so this low-tier authority can no longer add authorities (IDENTITY_LAYER_DESIGN.md §2.5.2). Recover via a backup passkey or a Self.xyz re-bind (§2.5.3).') {
        super(message);
    }
}
/** The active authority is already a high-tier passkey — nothing to upgrade. */
export class AlreadyHighTierError extends PasskeyUpgradeError {
    constructor(message = '[cofferdam-sdk] active authority is already a high-tier passkey; there is no first-passkey enrolment to perform.') {
        super(message);
    }
}
/**
 * A managed (Polis SSO) authority cannot use the consumer ratchet. It upgrades
 * via the enterprise addAuthority OR-semantics path (§3.10), not here.
 */
export class ManagedAuthorityNotUpgradableError extends PasskeyUpgradeError {
    constructor(message = '[cofferdam-sdk] a managed Polis-SSO authority is not upgraded via the consumer ratchet; use the enterprise addAuthority path (IDENTITY_LAYER_DESIGN.md §3.10).') {
        super(message);
    }
}
/** No viable enrolment lane on this surface (no app + no in-browser passkey). */
export class PasskeyUpgradeUnsupportedError extends PasskeyUpgradeError {
    constructor(message = '[cofferdam-sdk] no viable passkey-enrolment lane on this device; route the user to install the Cofferdam app (IDENTITY_LAYER_DESIGN.md §3.12 C3).') {
        super(message);
    }
}
/**
 * Guard the first-passkey enrolment. Throws when the AA is not in a state where
 * an untrusted low-tier authority may enrol the first passkey:
 * - `AlreadyHighTierError`              — the active authority is already a passkey.
 * - `ManagedAuthorityNotUpgradableError`— the active authority is Polis SSO.
 * - `UpgradePathLockedError`            — a passkey already exists (ratchet fired).
 */
export function assertCanEnrollFirstPasskey(state) {
    if (state.active.tier === 'high')
        throw new AlreadyHighTierError();
    if (state.active.tier === 'low_managed')
        throw new ManagedAuthorityNotUpgradableError();
    if (state.upgradeLocked || state.passkeyCount > 0)
        throw new UpgradePathLockedError();
}
// ── Upgrade directive (what the consumer should do next) ──────────────────────
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
export function evaluateUpgrade(state, capability = DEFAULT_DEVICE_CAPABILITY, policy = {}) {
    if (state.active.tier === 'high') {
        // Self-custodied already; the only nudge is a recovery backup (§2.5.3),
        // and only while a single device exists and we are under the ≤3 cap.
        if (state.passkeyCount === 1) {
            const lane = chooseEnrollmentLane(capability, policy) ?? 'qr_handoff';
            return { recommended: true, required: false, lane, reason: 'add_backup_device' };
        }
        return null;
    }
    // Managed low-tier (Polis SSO): not the consumer ratchet path.
    if (state.active.tier === 'low_managed')
        return null;
    // Untrusted low-tier: must upgrade — unless the ratchet has already fired.
    if (state.upgradeLocked || state.passkeyCount > 0)
        return null;
    const lane = chooseEnrollmentLane(capability, policy);
    if (!lane) {
        // No viable lane ⇒ the consumer must route the user to install the app.
        return { recommended: true, required: true, lane: 'qr_handoff', reason: 'install_app_required' };
    }
    return { recommended: true, required: true, lane, reason: 'untrusted_low_tier_no_passkey' };
}
// ── Response → state projection ───────────────────────────────────────────────
/**
 * Synthesize an `AuthorityState` from a `SignInResponse` for providers that
 * report `authority` on the response but do not implement `getAuthorityState`.
 * Falls back to conservative defaults derived from the authority tier.
 */
export function authorityStateFromResponse(response) {
    const active = response.authority ?? { kind: 'passkey', tier: 'high' };
    const isHigh = active.tier === 'high';
    return {
        active,
        passkeyCount: isHigh ? 1 : 0,
        upgradeLocked: isHigh,
        accountDeployed: response.accountDeployed ?? isHigh,
        migrationStatus: response.migrationStatus ?? (isHigh ? 'enrolled' : 'pending'),
    };
}
/**
 * Advance the consumer-side `migrationStatus`. Enrolment is terminal: once
 * `enrolled`, neither `declined` nor `reset` can move it backward.
 */
export function nextMigrationStatus(current, event) {
    if (current === 'enrolled')
        return 'enrolled';
    switch (event) {
        case 'passkey_enrolled':
            return 'enrolled';
        case 'declined':
            return 'declined';
        case 'reset':
            return 'pending';
    }
}
//# sourceMappingURL=authority.js.map