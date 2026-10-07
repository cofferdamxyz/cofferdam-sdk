// Top-level Cofferdam SDK class — the framework-agnostic entry point.
//
// Wraps a CofferdamProvider (MockProvider in α-1; LocalChainProvider in α-2;
// TestnetProvider in α-3; ProductionProvider in β). Consumer apps construct
// one instance per scope and reuse it across the session.
import { authorityStateFromResponse, chooseEnrollmentLane, DEFAULT_DEVICE_CAPABILITY, evaluateUpgrade, nextMigrationStatus, PasskeyUpgradeUnsupportedError, } from './identity/authority.js';
import { MockProvider } from './providers/MockProvider.js';
export class Cofferdam {
    scope;
    scopeDisplayName;
    scopeIcon;
    network;
    defaultPolicy;
    provider;
    currentSession = null;
    constructor(config) {
        this.scope = config.scope;
        this.scopeDisplayName = config.scopeDisplayName;
        this.scopeIcon = config.scopeIcon;
        this.network = config.network ?? 'mock';
        this.defaultPolicy = config.policy ?? {};
        if (config.provider) {
            this.provider = config.provider;
        }
        else if (this.network === 'mock') {
            this.provider = new MockProvider({ scope: this.scope });
        }
        else {
            throw new Error(`[cofferdam-sdk] network='${this.network}' has no built-in provider in this version. ` +
                `Pass a custom provider via config.provider. ` +
                `(LocalChainProvider lands in Phase α-2; TestnetProvider in α-3; ProductionProvider in β.)`);
        }
    }
    /**
     * Begin a sign-in flow. In α-1 this resolves in-process via the MockProvider;
     * in later phases it opens the Cofferdam mobile app via deep-link and waits
     * for the return callback.
     */
    async signIn(opts) {
        const policy = {
            ...this.defaultPolicy,
            ...(opts?.policy ?? {}),
        };
        const result = await this.provider.signIn(policy);
        this.currentSession = await this.withUpgradeDirective(result, policy);
        return this.currentSession;
    }
    /**
     * Run the consumer password→passkey migration (rev-7.7; IDENTITY_LAYER_DESIGN
     * §3.12 C3–C6). Enrols the FIRST device passkey for an untrusted low-tier
     * session, deploying the counterfactual AA and firing the one-way ratchet.
     *
     * Throws (via the provider's `enrollFirstPasskey` → `assertCanEnrollFirstPasskey`)
     * when the ratchet has already fired, the session is already high-tier, or the
     * authority is a managed Polis-SSO authority. Throws
     * `PasskeyUpgradeUnsupportedError` when the provider cannot enrol or no lane is
     * viable on this device.
     */
    async upgradeToPasskey(opts) {
        const session = this.currentSession;
        if (!session) {
            throw new Error('[cofferdam-sdk] upgradeToPasskey: call signIn() first.');
        }
        const provider = this.provider;
        const enrollFirstPasskey = provider.enrollFirstPasskey;
        if (!enrollFirstPasskey) {
            throw new PasskeyUpgradeUnsupportedError(`[cofferdam-sdk] provider (mode='${provider.mode}') does not implement passkey enrolment.`);
        }
        const capability = provider.deviceCapability?.() ?? DEFAULT_DEVICE_CAPABILITY;
        const lane = opts?.lane ??
            chooseEnrollmentLane(capability, {
                allowInBrowserPasskey: this.defaultPolicy.allowInBrowserPasskey,
            });
        if (!lane)
            throw new PasskeyUpgradeUnsupportedError();
        // The provider (and ultimately the on-chain validator) enforce the ratchet;
        // enrollFirstPasskey throws if the AA is not in an upgradable state.
        const result = await enrollFirstPasskey.call(provider, { lane });
        this.currentSession = {
            ...session,
            accountAddress: result.accountAddress,
            authority: result.authority,
            migrationStatus: result.migrationStatus,
            accountDeployed: result.accountDeployed,
            upgrade: null,
        };
        return result;
    }
    /**
     * Record that the user declined the passkey upgrade. The AA stays
     * counterfactual and is re-prompted on a later sign-in (WEB3_CONVERSION §7).
     * A no-op once the user is already `enrolled`.
     */
    async declinePasskeyUpgrade() {
        const session = this.currentSession;
        if (!session)
            return;
        await this.provider.declineMigration?.();
        this.currentSession = {
            ...session,
            migrationStatus: nextMigrationStatus(session.migrationStatus ?? 'pending', 'declined'),
            upgrade: null,
        };
    }
    /** Attach the orchestration-derived upgrade directive to a fresh session. */
    async withUpgradeDirective(result, policy) {
        // Providers that predate the tiered-authority model omit `authority`.
        if (!result.authority)
            return result;
        const state = (await this.provider.getAuthorityState?.()) ?? authorityStateFromResponse(result);
        const capability = this.provider.deviceCapability?.() ?? DEFAULT_DEVICE_CAPABILITY;
        const upgrade = evaluateUpgrade(state, capability, {
            allowInBrowserPasskey: policy.allowInBrowserPasskey,
        });
        return { ...result, upgrade };
    }
    /** Return the current in-memory session, or null if not signed in. */
    getSession() {
        return this.currentSession;
    }
    /** Clear the in-memory session and let the provider release any state. */
    signOut() {
        this.currentSession = null;
        this.provider.signOut?.();
    }
}
//# sourceMappingURL=Cofferdam.js.map