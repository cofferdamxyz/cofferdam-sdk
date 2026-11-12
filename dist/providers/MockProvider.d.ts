import type { AuthorityKind, AuthorityState, CofferdamProvider, DeviceCapability, EnrollFirstPasskeyOptions, MigrationStatus, NetworkMode, PasskeyEnrollmentResult, SignInErrorCode, SignInPolicy, SignInResponse, VerifiedClaims } from '../types.js';
export { mockProfiles, getMockProfile } from './mockProfiles.js';
export type { MockProfile, MockProfileName } from './mockProfiles.js';
export interface MockProviderConfig {
    scope: string;
    /**
     * Override the per-scope salt. Defaults to a deterministic derivation from
     * the scope string. In production, the real salt comes from the Cofferdam
     * backend at integration-onboarding time.
     */
    scopeSalt?: string;
    /**
     * Stable mock user identifier. Different values produce different
     * pseudonyms and account addresses. Default: 'mock-user-default'.
     */
    mockUserId?: string;
    /** Whether the mock user has completed Self verification. Default: true. */
    verified?: boolean;
    verifiedClaims?: Partial<VerifiedClaims>;
    /**
     * Simulated async latency (ms). Lets UI exercise loading / pending states.
     * Default: 250.
     */
    latencyMs?: number;
    /**
     * Authority kind this mock login represents (rev-7.7). Default: 'passkey'
     * (a self-custodied, high-tier user). Use 'password' / 'oauth_google' /
     * 'oauth_apple' to model an untrusted low-tier login that needs migration,
     * or 'polis_sso' for a managed enterprise authority.
     */
    authorityKind?: AuthorityKind;
    /** Mock device capabilities for the enrolment-lane branch (§3.12 C3). */
    deviceCapability?: Partial<DeviceCapability>;
    /** Initial migration status. Default: derived from `authorityKind`. */
    migrationStatus?: MigrationStatus;
    /**
     * Whether the AA is already deployed. Default: true for a passkey login,
     * false (counterfactual) for a low-tier login (§3.12 C2).
     */
    accountDeployed?: boolean;
    /** Device passkeys already registered. Default: 1 for passkey, else 0. */
    passkeyCount?: number;
}
export declare class SignInRejected extends Error {
    readonly code: SignInErrorCode;
    constructor(code: SignInErrorCode, message?: string);
}
export declare class MockProvider implements CofferdamProvider {
    readonly mode: NetworkMode;
    private readonly config;
    private readonly capability;
    private state;
    constructor(config: MockProviderConfig);
    signIn(policy: SignInPolicy): Promise<SignInResponse>;
    signOut(): void;
    getAuthorityState(): Promise<AuthorityState>;
    deviceCapability(): DeviceCapability;
    enrollFirstPasskey(opts: EnrollFirstPasskeyOptions): Promise<PasskeyEnrollmentResult>;
    declineMigration(): Promise<void>;
}
//# sourceMappingURL=MockProvider.d.ts.map