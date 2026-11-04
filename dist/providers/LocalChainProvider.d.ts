import type { CofferdamProvider, NetworkMode, SignInPolicy, SignInResponse, VerifiedClaims } from '../types.js';
export { SignInRejected } from './MockProvider.js';
export interface LocalChainProviderConfig {
    /** Consumer-app identifier (e.g. 'offshoresync'). Same semantics as MockProvider. */
    scope: string;
    /**
     * Per-scope salt. Defaults to a deterministic derivation from `scope`. In
     * production the real salt comes from the Cofferdam backend at
     * integration-onboarding time.
     */
    scopeSalt?: string;
    /** RPC URL of the Base node. Local default: 'http://127.0.0.1:8545' (base-anvil). */
    rpcUrl: string;
    /** Chain id. base-anvil default = 31337; Base Sepolia = 84532; Base mainnet = 8453. */
    chainId: number;
    /** Deployed Base contract addresses. */
    contracts: {
        /** `NullifierRegistry` address — used for identity binding checks. */
        nullifierRegistry: string;
        /** `CofferdamSpotEscrow` — currently informational; reserved for future
         *  flows (e.g. provider returning a pre-funded escrow handle). */
        escrow?: string;
    };
    /**
     * Stable user id. Different values produce different addresses and
     * pseudonyms. Default: 'mock-user-default'.
     */
    mockUserId?: string;
    /**
     * Funded EOA private key. If provided, `signIn()` will pre-fund the user's
     * derived account so it can post / award / dispute on-chain. PoC
     * convenience only.
     *
     * On Base, identity binding is NOT performed with this key — the production
     * path requires a Groth16 proof from Self.xyz's GCP enclave + an
     * attester signature from the cofferdam-attester Worker, submitted via an
     * ERC-4337 UserOp to `NullifierRegistry.verifyAndBind`.
     *
     * Production-deployed clients NEVER hold this key. It exists only to let
     * local PoC flows exercise the full happy path without orchestrating a
     * separate admin sidecar service.
     */
    adminPrivateKey?: string;
    /**
     * If provided AND admin key is set, top up the derived account up to
     * `prefundEth` (in wei) before binding. Useful so the derived EOA can
     * subsequently call `postContract`. Default: 0 (no pre-funding).
     */
    prefundWei?: bigint;
    /** PoC parity with MockProvider — does the user "have" a verified passport? */
    verified?: boolean;
    verifiedClaims?: Partial<VerifiedClaims>;
    /** Optional simulated latency between signIn() steps for UI testing. */
    latencyMs?: number;
}
export declare class LocalChainProvider implements CofferdamProvider {
    readonly mode: NetworkMode;
    private readonly config;
    private readonly chainProvider;
    constructor(config: LocalChainProviderConfig);
    signIn(policy: SignInPolicy): Promise<SignInResponse>;
    signOut(): void;
    private maybePrefund;
    /**
     * Check whether the user's account is identity-bound on-chain via
     * `NullifierRegistry.isAccountBound`. This is a read-only check — actual
     * binding requires the full prover + attester pipeline.
     */
    isAccountBound(accountAddress: string): Promise<boolean>;
}
//# sourceMappingURL=LocalChainProvider.d.ts.map