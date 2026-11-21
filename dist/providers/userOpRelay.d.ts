/**
 * UserOperation relay — the production path for submitting a signed ERC-4337
 * `PackedUserOperation`. The client never holds a funded key: it POSTs the
 * signed op to the plane (`cofferdam-api`, `POST /v1/aa/user-operation`),
 * whose relayer calls `EntryPoint.handleOps` with its own key and is refunded
 * from the paymaster's deposit. A not-yet-deployed account rides along: the
 * op's `initCode` (factory ++ `deployAccount` calldata) makes the EntryPoint
 * create it in the same bundle, so the first sponsored op is the deployment.
 *
 * The helpers are pure and unit-tested; the HTTP call takes an injectable
 * `fetch` so callers (and tests) can supply their own.
 */
import { type Interface } from 'ethers';
import type { Permission } from './permission.js';
/** EntryPoint v0.7 packed operation, as the SDK builds and signs it. */
export interface PackedUserOperation {
    sender: string;
    nonce: bigint;
    initCode: string;
    callData: string;
    accountGasLimits: string;
    preVerificationGas: bigint;
    gasFees: string;
    paymasterAndData: string;
    signature: string;
}
/** Wire shape: bigints as decimal strings, bytes as `0x` hex. */
export interface PackedUserOperationJson {
    sender: string;
    nonce: string;
    initCode: string;
    callData: string;
    accountGasLimits: string;
    preVerificationGas: string;
    gasFees: string;
    paymasterAndData: string;
    signature: string;
}
/** Route on the plane that relays a signed op. */
export declare const USER_OPERATION_PATH = "/v1/aa/user-operation";
export declare function serializeUserOperation(op: PackedUserOperation): PackedUserOperationJson;
/**
 * `initCode` for EntryPoint v0.7: the factory address followed by the
 * `deployAccount(initialModule, initialConfig, salt)` calldata. The EntryPoint
 * calls the factory through its SenderCreator and requires the returned
 * address to equal `sender` (AA14 otherwise).
 */
export declare function buildInitCode(factory: string, factoryIface: Interface, initialModule: string, initialConfig: string, initialPermission: Permission, salt: string): string;
/**
 * The plane refused or failed to relay the op. `code` is its error id; the
 * ones a caller acts on (cofferdam-api `routes/aa.ts`). A message that names
 * a revert names the error only (`WrongBoundDigest`, `IdentifierAlreadyBound`),
 * never its arguments.
 *   - `identity_check_failed` (400): on the mainnet test lane, the identity
 *     registry's `check` refused the bind, relink or rebind; nothing was sent.
 *   - `execution_reverted` (400): the pre-flight found that the op's own call
 *     would revert; nothing was sent.
 *   - `user_op_reverted` (422): mined, and the op's call reverted; `txHash` is set.
 *   - `simulation_failed` (400): validation failed (`AAxx`); nothing was sent.
 *   - `fee_too_low`, `pre_verification_gas_too_low` (400): the mainnet test
 *     lane's fee floor and L1-fee floor (`preVerificationGas: 'l1-fee'` meets them).
 *   - `chain_unsupported` (400), `not_test_account` (403): the lane is off, or
 *     the account is not on its allowlist.
 *   - `preflight_unavailable` (503): the plane's node cannot pre-flight; nothing
 *     was sent.
 *   - `rate_limited` (429): nothing was sent; retry later.
 *   - `relay_failed` (502): the plane could not confirm its send, which the
 *     node may still have taken. `NativeAccountProvider.sendTransaction` looks
 *     the op up (as it does when the connection drops before an answer) and
 *     answers its receipt, its revert, or `UserOperationFailedError('unknown')`;
 *     re-read before any retry.
 */
export declare class UserOpRelayError extends Error {
    readonly code: string;
    readonly status: number;
    /** The mined transaction, for `user_op_reverted`. */
    readonly txHash: string | null;
    constructor(code: string, message: string, status: number, 
    /** The mined transaction, for `user_op_reverted`. */
    txHash?: string | null);
}
/**
 * Whether a refusal may follow a send the node took: a 5xx other than
 * `preflight_unavailable` (503, whose pre-flight sent nothing).
 */
export declare function mayHaveBeenSent(err: UserOpRelayError): boolean;
/**
 * What the plane saw of the op's receipt within its wait: `success` (the op's
 * own event said so), `pending` (no receipt in time) or `unknown` (`handleOps`
 * reverted in this transaction; a resend may have carried the op earlier).
 * Absent from planes before decision 0080's relay. The client checks the op's
 * own event whatever this says (`confirmUserOperation`).
 */
export type RelayReceiptState = 'success' | 'pending' | 'unknown';
export interface RelayUserOperationResult {
    txHash: string;
    receipt: RelayReceiptState | null;
}
export interface RelayUserOperationOptions {
    /** Plane base URL, e.g. `https://cofferdam-api.example.workers.dev`. */
    relayerUrl: string;
    userOp: PackedUserOperation;
    /** EntryPoint the op was hashed against; the plane refuses any other. */
    entryPoint: string;
    /**
     * The op's chain. The plane picks the lane from it and takes Base Sepolia
     * when it is absent; Base mainnet (8453) reaches only the test relay of
     * decision 0080 M2, off unless the plane enables it.
     */
    chainId?: number | undefined;
    fetchImpl?: typeof fetch | undefined;
}
/**
 * POST the signed op to the plane; resolves with the `handleOps` tx hash once
 * the plane accepted it (`202`). Acceptance is not success: confirm the op
 * with `confirmUserOperation`, as `NativeAccountProvider.sendTransaction` does.
 */
export declare function relayUserOperation(opts: RelayUserOperationOptions): Promise<RelayUserOperationResult>;
//# sourceMappingURL=userOpRelay.d.ts.map