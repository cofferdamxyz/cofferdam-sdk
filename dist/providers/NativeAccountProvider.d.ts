import { type TransactionReceipt } from 'ethers';
import { type PasskeySigner, type P256PublicKey } from '../identity/passkey.js';
import { type SessionSigner } from '../identity/sessionKey.js';
import type { AuthorityKind, AuthorityState, AuthorityTier, CofferdamProvider, DeviceCapability, EnrollFirstPasskeyOptions, NetworkMode, PasskeyEnrollmentResult, SignInPolicy, SignInResponse, VerifiedClaims } from '../types.js';
export { SignInRejected } from './MockProvider.js';
/**
 * Client-side mirror of the on-chain `MAX_PASSKEYS` cap (AuthorityManagerBase).
 * The contract is the real enforcer; this lets the UI fail fast without gas.
 */
export declare const MAX_PASSKEYS = 3;
/** A single entry in the account's on-chain authority registry. */
export interface AuthorityRecord {
    /** Index in the registry — the `authorityId` used to sign / revoke. */
    id: number;
    /** Authority module contract address. */
    module: string;
    /** Trust tier of this authority. */
    tier: AuthorityTier;
    /** Best-effort authority kind for UI labelling. */
    kind: AuthorityKind;
    /** False once revoked. */
    active: boolean;
    /** True when the module is the configured passkey module (a device passkey). */
    isPasskey: boolean;
    /** True when this record's config matches THIS provider's signer public key. */
    isSelf: boolean;
    /** Opaque per-account authority config blob (abi.encode(qx,qy) for passkeys). */
    config: string;
}
/**
 * Thrown client-side before submitting a 4th passkey, mirroring the contract's
 * `PasskeyCapReached` revert so the UI can fail fast without spending gas.
 */
export declare class PasskeyCapReachedError extends Error {
    constructor(message?: string);
}
export type { SessionSigner } from '../identity/sessionKey.js';
/**
 * Genesis (authority 0) lane for the account. Defaults to the High-tier passkey
 * (sovereign-first onboarding). Set `{ kind: 'session', ... }` to bootstrap the
 * account from a web2 login via a server-held session signer — the legacy-auth
 * bridge (`SessionKeyAuthority`). This is what maps "any login credential" to an
 * on-chain account.
 */
export type GenesisAuthorityConfig = {
    kind: 'passkey';
} | {
    /** Bootstrap from a web2 login via a server session signer. */
    kind: 'session';
    /** `SessionKeyAuthority` module address (deployed at `tier`). */
    module: string;
    /**
     * Tier the module was deployed at. `low_untrusted` (password / OAuth) is
     * confined to first-passkey enrolment and locked out by the ratchet;
     * `low_managed` (Polis SSO) coexists with a later passkey.
     */
    tier: 'low_untrusted' | 'low_managed';
    /** Server-held session signer (an ethers `Wallet` works). */
    sessionSigner: SessionSigner;
    /** Optional UI label; defaults from `tier` (password / polis_sso). */
    authorityKind?: AuthorityKind;
};
export interface NativeAccountProviderConfig {
    /** Consumer-app identifier (e.g. 'offshoresync'). */
    scope: string;
    /** Per-scope salt for pseudonym derivation. Defaults to a value from `scope`. */
    scopeSalt?: string;
    /** RPC URL of the Base node. Local default: 'http://127.0.0.1:8545' (base-anvil). */
    rpcUrl: string;
    /** Chain id. base-anvil = 31337; Base Sepolia = 84532; Base mainnet = 8453. */
    chainId: number;
    contracts: {
        /** `CofferdamAccountFactory4337` address. */
        factory: string;
        /** `WebAuthnPasskeyAuthority` (High-tier) module address. */
        passkeyModule: string;
        /** `CofferdamPaymaster` address. Required for sponsored (gasless) txs.
         *  Production: use CDP Paymaster via paymasterService capability instead. */
        paymaster?: string;
        /**
         * Override the canonical ERC-4337 EntryPoint address. Defaults to
         * 0x0000000071727De22E5E9d8BAf0edAc6f37da032 (preinstalled on Base).
         * Override only for testing on non-Base chains.
         */
        entryPoint?: string;
    };
    /** Stable per-user id → deterministic CREATE2 salt (and PoC passkey). */
    userId?: string;
    /**
     * Pluggable passkey signer. Defaults to a deterministic software signer keyed
     * on `userId` (PoC). Swap for a hardware/WebAuthn signer in production. In the
     * session-genesis lane this is the FUTURE upgrade passkey (used by
     * `enrollFirstPasskey`).
     */
    signer?: PasskeySigner;
    /**
     * Genesis authority lane. Omit (or `{ kind: 'passkey' }`) for the High-tier
     * passkey default; set `{ kind: 'session', ... }` to map a web2 login onto the
     * account via the `SessionKeyAuthority` legacy-auth bridge.
     */
    genesisAuthority?: GenesisAuthorityConfig;
    /**
     * PoC deployer key. Deploying the counterfactual account is a normal tx that
     * needs gas; this key pays for it (and may fund the paymaster). NEVER ship
     * this in a client — production deploys via a relayer or the first sponsored
     * op.
     */
    deployerPrivateKey?: string;
    /**
     * Authority id this provider's signer occupies on the account. The bootstrap
     * passkey is id 0 (the default). A backup device should set this, pass
     * `authorityId` per tx, or call `resolveOwnAuthorityId()` to discover it.
     */
    authorityId?: number;
    /**
     * Override the counterfactual account address. A backup device does NOT derive
     * the account (its key differs from the bootstrap key); it is told the
     * canonical address out-of-band (the QR handoff / reconciliation flow) and
     * passes it here so all reads/txs target the shared account.
     */
    accountAddress?: string;
    /** Sponsor user txs via the paymaster. Default: true when `paymaster` is set. */
    usePaymaster?: boolean;
    /** Deploy the account during `signIn()` if not yet on-chain (needs deployer key). */
    autoDeploy?: boolean;
    /** Gas limit for AA txs when estimation is skipped/fails. Default 20_000_000. */
    defaultGasLimit?: bigint;
    verified?: boolean;
    verifiedClaims?: Partial<VerifiedClaims>;
    latencyMs?: number;
}
/** Parameters for an account-routed transaction. */
export interface NativeTxRequest {
    to: string;
    data?: string;
    value?: bigint;
    /** Override gas limit; otherwise estimated (with a default fallback). */
    gasLimit?: bigint;
    /** Override paymaster sponsorship for this tx. Defaults to provider setting. */
    usePaymaster?: boolean;
    /**
     * Authority id whose passkey signs this tx. Defaults to the provider's
     * configured `authorityId` (0 for the bootstrap device).
     */
    authorityId?: number;
}
export declare class NativeAccountProvider implements CofferdamProvider {
    readonly mode: NetworkMode;
    private readonly config;
    private readonly chainProvider;
    private readonly signer;
    private cachedPublicKey;
    private cachedAddress;
    private cachedSessionSignerAddress;
    constructor(config: NativeAccountProviderConfig);
    signIn(policy: SignInPolicy): Promise<SignInResponse>;
    signOut(): void;
    getAuthorityState(): Promise<AuthorityState>;
    deviceCapability(): DeviceCapability;
    /** The counterfactual smart-account address for the configured user. */
    getAccountAddress(): Promise<string>;
    /** Whether the smart account has been deployed on-chain. */
    isDeployed(): Promise<boolean>;
    /**
     * Deploy the counterfactual account via the factory (idempotent). Requires
     * `deployerPrivateKey`. Returns the account address.
     */
    ensureDeployed(): Promise<string>;
    /**
     * Submit an ERC-4337 UserOperation from the smart account, signed by the
     * passkey authority and, by default, sponsored by the paymaster. The UserOp's
     * callData encodes `account.execute(target, value, data)`, which the EntryPoint
     * calls after `validateUserOp` succeeds. Auto-deploys the account first if a
     * deployer key is configured.
     */
    sendTransaction(req: NativeTxRequest): Promise<TransactionReceipt>;
    /**
     * Enumerate the account's on-chain authority registry: every device passkey
     * (High) plus any managed/Self authorities. Skips never-populated (`None`)
     * slots. On a counterfactual (not-yet-deployed) account, returns the single
     * bootstrap passkey at id 0.
     */
    listAuthorities(): Promise<AuthorityRecord[]>;
    /**
     * Resolve the authority id whose config matches THIS provider's signer public
     * key. The bootstrap device is id 0; a backup device discovers its own id
     * (1/2) here so it can sign management txs. Throws if the key is not an active
     * authority on the account.
     */
    resolveOwnAuthorityId(): Promise<number>;
    /**
     * Add a backup device passkey as a new High-tier authority via a self-call to
     * `addAuthority`, authorised by `authorityId` (a High signer; default the
     * provider's). Fails fast with `PasskeyCapReachedError` if already at the cap.
     */
    addBackupPasskey(pub: P256PublicKey, opts?: {
        authorityId?: number;
    }): Promise<TransactionReceipt>;
    /**
     * Revoke (deactivate) an authority by id via a self-call to `revokeAuthority`,
     * authorised by `authorityId` (a High signer; default the provider's). The
     * contract decrements `passkeyCount` if the target was an active passkey.
     */
    revokeAuthority(targetId: number, opts?: {
        authorityId?: number;
    }): Promise<TransactionReceipt>;
    /**
     * Enrol the FIRST device passkey from a web2-credential (session) account and
     * FIRE THE ONE-WAY RATCHET: the account gains a High-tier passkey and every
     * LowUntrusted authority (the original web2 login) is permanently deactivated
     * (IDENTITY_LAYER_DESIGN.md §2.5.2). This is the single action a LowUntrusted
     * authority may perform. The new passkey is this provider's `signer` (the PoC
     * deterministic passkey by default; pass a hardware/WebAuthn signer in prod).
     *
     * Only valid in the session lane; the passkey lane is already High-tier.
     */
    enrollFirstPasskey(_opts?: EnrollFirstPasskeyOptions): Promise<PasskeyEnrollmentResult>;
    /**
     * Estimate gas for an ERC-4337 UserOp by eth_estimateGas on the execute call.
     * This is a rough approximation — production should use a bundler's
     * `eth_estimateUserOperationGas` RPC method.
     */
    private estimateGas;
    private salt;
    private publicKey;
    /** Genesis authority module address (passkey module or session module). */
    private genesisModule;
    /** Resolve (and cache) the server session-signer address. */
    private sessionSignerAddress;
    /**
     * Genesis authority config blob: `abi.encode(qx, qy)` for the passkey lane, or
     * `abi.encode(sessionSigner)` for the web2-credential (session) lane.
     */
    private bootstrapConfig;
    /** The descriptor for the configured genesis authority. */
    private genesisDescriptor;
    /** Sign an account digest with the genesis authority's inner signature. */
    private signInner;
    /**
     * Session-lane attestation: an ECDSA envelope signed by the server session
     * signer over the security-relevant sign-in fields. Honest about its origin
     * (the legacy-auth bridge vouched), distinct from the P-256 `csa1:` passkey
     * attestation. Format: `csa-sess1.<base64url(json)>.<0x sig>`.
     */
    private signSessionModeAttestation;
    private enforcePolicy;
}
//# sourceMappingURL=NativeAccountProvider.d.ts.map