import type { CofferdamConfig, EnrollmentLane, NetworkMode, PasskeyEnrollmentResult, SignInPolicy, SignInResponse } from './types.js';
export declare class Cofferdam {
    readonly scope: string;
    readonly scopeDisplayName: string;
    readonly scopeIcon: string | undefined;
    readonly network: NetworkMode;
    readonly defaultPolicy: SignInPolicy;
    private readonly provider;
    private currentSession;
    constructor(config: CofferdamConfig);
    /**
     * Begin a sign-in flow. In α-1 this resolves in-process via the MockProvider;
     * in later phases it opens the Cofferdam mobile app via deep-link and waits
     * for the return callback.
     */
    signIn(opts?: {
        policy?: SignInPolicy;
    }): Promise<SignInResponse>;
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
    upgradeToPasskey(opts?: {
        lane?: EnrollmentLane;
    }): Promise<PasskeyEnrollmentResult>;
    /**
     * Record that the user declined the passkey upgrade. The AA stays
     * counterfactual and is re-prompted on a later sign-in (WEB3_CONVERSION §7).
     * A no-op once the user is already `enrolled`.
     */
    declinePasskeyUpgrade(): Promise<void>;
    /** Attach the orchestration-derived upgrade directive to a fresh session. */
    private withUpgradeDirective;
    /** Return the current in-memory session, or null if not signed in. */
    getSession(): SignInResponse | null;
    /** Clear the in-memory session and let the provider release any state. */
    signOut(): void;
}
//# sourceMappingURL=Cofferdam.d.ts.map