/**
 * `CofferdamIdentityRegistry` (workspace decision 0080): the provider-agnostic
 * registry that binds one person's identifier to one Cofferdam account, and
 * its first evidence adapter, `ZKPassportEvidenceAdapter`.
 *
 * The flow a client runs for a bind:
 *   1. `client.customData('bind', account)`: the registry's digest for the
 *      account's next action, as the 66-character lowercase hex string the
 *      ZKPassport request must bind as `custom_data` (with `user_address` =
 *      the account and chain `base`).
 *   2. The proof comes back; `zkpEvidenceFromParams(params)` turns ZKPassport's
 *      `getSolidityVerifierParameters` result into the adapter's `evidence`.
 *   3. `client.check('bind', account, adapter, evidence)` by `eth_call`: the
 *      same checks the transaction runs, or the same revert.
 *   4. The account sends `{ to: registry, data: encodeBindCall(adapter, evidence) }`
 *      as its own user operation (`NativeAccountProvider.sendTransaction`,
 *      which throws unless the operation itself succeeded).
 *   5. `client.isAccountBound(account)` says "verified".
 *
 * A re-bind (decision 0022) moves a bound identifier to a new, unbound
 * account: the new account proves against `customData('rebind', account)`,
 * checks with `check('rebind', …)` and sends `encodeRequestRebindCall`. After
 * the registry's `REBIND_DELAY` anyone sends `encodeFinalizeRebindCall(identifier)`,
 * the identifier read from the request's own `RebindRequested` event
 * (`rebindRequestedFromLogs`), never stored; the bound account may veto it
 * meanwhile with `encodeCancelRebindCall`.
 *
 * The encodings must equal base-contracts' `scripts/lib/identity.ts` byte for
 * byte; `test/fixtures/identity-digest.json` (copied from base-contracts)
 * pins the digest and `custom_data`.
 *
 * The identifier the registry returns and the registry's errors' arguments
 * name the passport: never log, store or send them. Errors here carry only
 * the error's name.
 */
import { type ContractRunner } from 'ethers';
/** The action tags; the registry folds `keccak256(tag)` into the digest. */
export declare const IDENTITY_ACTION_TAGS: {
    readonly bind: "cofferdam-identity-bind-v1";
    readonly rebind: "cofferdam-identity-rebind-v1";
    readonly relink: "cofferdam-identity-relink-v1";
};
export type IdentityAction = keyof typeof IDENTITY_ACTION_TAGS;
/** `BIND`, `REBIND`, `RELINK` as the registry holds them: `keccak256(tag)`. */
export declare const IDENTITY_ACTIONS: Readonly<Record<IdentityAction, string>>;
/**
 * `CofferdamIdentityRegistry.digest(action, account)` computed off-chain:
 * `keccak256(abi.encode(keccak256(tag), chainId, registry, account, nonce))`,
 * where `nonce` is `registry.nonces(account)`. Prefer reading it from the
 * registry (`CofferdamIdentityRegistryClient.digest`); this is for tests and
 * for checking a digest you were handed.
 */
export declare function identityDigest(action: IdentityAction, chainId: bigint | number, registry: string, account: string, nonce: bigint | number): string;
/**
 * The ZKPassport `custom_data` a proof must be bound to: the digest as
 * lowercase `0x` hex, 66 characters. The adapter compares strings, so any other
 * spelling (upper case, no `0x`) fails with `WrongBoundDigest`.
 */
export declare function zkpCustomData(digest: string): string;
/** A compressed-EVM proof as ZKPassport's SDK `getSolidityVerifierParameters` returns it (0.19.x). */
export interface ZkpSolidityParams {
    version: string;
    proofVerificationData: {
        vkeyHash: string;
        proof: string;
        publicInputs: string[];
    };
    committedInputs: string;
    serviceConfig: {
        validityPeriodInSeconds: number;
        domain: string;
        scope: string;
        devMode: boolean;
    };
}
/** The proof fields the adapter takes. */
export interface ZkpEvidence {
    vkeyHash: string;
    proof: string | Uint8Array;
    publicInputs: string[];
    committedInputs: string | Uint8Array;
}
/**
 * `ZKPassportEvidenceAdapter` evidence:
 * `abi.encode(bytes32 vkeyHash, bytes proof, bytes32[] publicInputs, bytes committedInputs)`.
 */
export declare function encodeZkpEvidence(p: ZkpEvidence): string;
/**
 * The adapter's evidence from ZKPassport's verifier parameters: only the
 * proof's own fields. `version` and `serviceConfig` are not sent; the adapter
 * pins its circuits version, domain, scope and validity.
 */
export declare function zkpEvidenceFromParams(params: ZkpSolidityParams): string;
/** The registry's surface this SDK uses, with the registry's and the adapter's errors so reverts decode by name. */
export declare const COFFERDAM_IDENTITY_REGISTRY_ABI: readonly ["function bind(address adapter, bytes evidence)", "function requestRebind(address adapter, bytes evidence)", "function finalizeRebind(bytes32 identifier)", "function cancelRebind(bytes32 identifier)", "function pendingRebind(bytes32 identifier) view returns (address oldAccount, address newAccount, uint48 readyAt, address adapter)", "event RebindRequested(address indexed oldAccount, address indexed newAccount, bytes32 indexed identifier, uint256 nonce, uint48 readyAt)", "function digest(bytes32 action, address account) view returns (bytes32)", "function nonces(address account) view returns (uint256)", "function isAccountBound(address account) view returns (bool)", "function check(bytes32 action, address account, address adapter, bytes evidence) view returns (bytes32 identifier, address counterpart)", "error NotOwner()", "error NotPendingOwner()", "error ZeroAddress()", "error ZeroValue()", "error DelayTooShort(uint256 delay, uint256 minimum)", "error DelayTooLong(uint256 delay, uint256 maximum)", "error Paused()", "error NotTestAccount(address account)", "error UnknownAction(bytes32 action)", "error AdapterNotActive(address adapter)", "error AdapterAlreadyActive(address adapter)", "error AdapterNotProposed(address adapter)", "error AdapterNotReady(uint256 readyAt)", "error AdapterProposalExpired(uint256 expiredAt)", "error WrongIdentifierKind(bytes32 expected, bytes32 got)", "error WrongScope(bytes32 expected, bytes32 got)", "error ZeroIdentifier()", "error RetiredIdentifier(bytes32 identifier)", "error AccountAlreadyBound(address account, bytes32 identifier)", "error IdentifierAlreadyBound(bytes32 identifier, address account)", "error AccountNotBound(address account)", "error IdentifierNotBound(bytes32 identifier)", "error SameIdentifier(bytes32 identifier)", "error SameAccount(address account)", "error NoPendingRebind(bytes32 identifier)", "error RebindNotReady(uint48 readyAt)", "error RebindStale(bytes32 identifier)", "error NotBoundAccount(address caller, address bound)", "error MalformedEvidence()", "error WrongIdentifierType(uint256 expected, uint256 got)", "error WrongOprfKey(bytes32 expected, bytes32 got)", "error ProofInvalid()", "error IdentifierMismatch(bytes32 verified, bytes32 publicInput)", "error HelperMismatch(address expected, address got)", "error WrongBoundAccount(address expected, address got)", "error WrongBoundChain(uint256 expected, uint256 got)", "error WrongBoundDigest()", "error AgeNotProven(uint8 minAge)", "error ExpiryNotProven(uint256 earliest)", "error DisclosureRefused(uint8 sectionType)", "error MalformedCommittedInputs()", "error BindSectionCount(uint256 count)"];
/** Calldata for `registry.bind(adapter, evidence)`, sent by the account itself (the registry binds `msg.sender`). */
export declare function encodeBindCall(adapter: string, evidence: string): string;
/**
 * Calldata for `registry.requestRebind(adapter, evidence)`, sent by the new,
 * unbound account with a proof bound to `customData('rebind', account)`.
 */
export declare function encodeRequestRebindCall(adapter: string, evidence: string): string;
/** Calldata for `registry.finalizeRebind(identifier)`, once the pending rebind's `readyAt` has passed (anyone may send it). */
export declare function encodeFinalizeRebindCall(identifier: string): string;
/** Calldata for `registry.cancelRebind(identifier)`, sent by the account the identifier is bound to now. */
export declare function encodeCancelRebindCall(identifier: string): string;
/** A `RebindRequested` event: `identifier` names the passport, so keep it in memory only. */
export interface RebindRequest {
    oldAccount: string;
    newAccount: string;
    identifier: string;
    /** Unix seconds from which `finalizeRebind` applies it. */
    readyAt: number;
}
/**
 * The rebind request `newAccount` made, from a receipt's logs (the
 * `requestRebind` op's transaction); null when the logs hold none. Logs of
 * other contracts and other accounts are skipped.
 */
export declare function rebindRequestedFromLogs(logs: readonly {
    address: string;
    topics: readonly string[];
    data: string;
}[], registry: string, newAccount: string): RebindRequest | null;
/**
 * A revert's name, never its arguments (they carry the passport's identifier):
 * a registry or adapter error's name, `Error` or `Panic` for Solidity's own,
 * the 4-byte selector for an unknown error, `empty` for no data.
 */
export declare function identityRevertName(data: string | null | undefined): string;
/** The registry refused: `errorName` is the registry's or the adapter's error (see `identityRevertName`). */
export declare class IdentityRegistryError extends Error {
    readonly errorName: string;
    constructor(errorName: string);
}
export interface CofferdamIdentityRegistryClientConfig {
    /** The registry's address, from the caller's configuration (no address table). */
    address: string;
    /** A read-only runner, e.g. an ethers `JsonRpcProvider` on the registry's chain. */
    runner: ContractRunner;
}
/** What `check` proves: the identifier, and the account it is bound to now (REBIND) or the account itself (RELINK). */
export interface IdentityCheckResult {
    /** Names the passport: never log, store or send it. */
    identifier: string;
    /** Zero address for BIND. */
    counterpart: string;
}
/** A pending rebind as the registry holds it; `newAccount` is the zero address when none is pending. */
export interface PendingRebind {
    oldAccount: string;
    newAccount: string;
    /** Unix seconds. */
    readyAt: number;
    adapter: string;
}
/** Read-only client for `CofferdamIdentityRegistry`. Writes go through the account (`encodeBindCall`, `encodeRequestRebindCall`, `encodeFinalizeRebindCall`). */
export declare class CofferdamIdentityRegistryClient {
    readonly address: string;
    private readonly contract;
    constructor(config: CofferdamIdentityRegistryClientConfig);
    /** The digest the account's next proof for `action` must be bound to (consumed by the action). */
    digest(action: IdentityAction, account: string): Promise<string>;
    /** `digest` as the ZKPassport request's `custom_data` (lowercase hex, 66 characters). */
    customData(action: IdentityAction, account: string): Promise<string>;
    /** The nonce the account's next proof is bound to; each bind, relink or rebind request consumes one. */
    nonces(account: string): Promise<bigint>;
    /** The rebind of `identifier` waiting for `REBIND_DELAY`; `newAccount` is the zero address when none is pending. */
    pendingRebind(identifier: string): Promise<PendingRebind>;
    /** Whether an identifier is bound to `account`. */
    isAccountBound(account: string): Promise<boolean>;
    /**
     * Pre-flight by `eth_call`: every check `bind`, `relink` or `requestRebind`
     * would run for `account` (the account that will send it). Throws
     * `IdentityRegistryError` with the error's name when the transaction would
     * revert, and a plain `Error` naming only the failure's code when the call
     * could not run (a node error, a rate limit). Neither carries the request:
     * ethers' own error holds the evidence, whose public inputs name the passport.
     */
    check(action: IdentityAction, account: string, adapter: string, evidence: string): Promise<IdentityCheckResult>;
}
//# sourceMappingURL=identityRegistry.d.ts.map