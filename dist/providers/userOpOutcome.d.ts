/**
 * Whether a user operation itself succeeded (workspace decision 0080 (3)).
 *
 * EntryPoint v0.7 reverts `handleOps` only when validation fails. A revert
 * inside the account's `execute` (a bind the registry refuses, a transfer
 * that fails) is caught: the transaction succeeds and the op's failure shows
 * only as `UserOperationEvent.success == false`, beside
 * `UserOperationRevertReason`. So a mined receipt is not a done op.
 *
 * The plane's relay (`POST /v1/aa/user-operation`) answers `202` with
 * `receipt: 'success' | 'pending' | 'unknown'`; for every one of them the
 * client reads the op's own event here. `unknown` means `handleOps` itself
 * reverted in the hash the plane returned, after a resend that may have
 * carried the op in an earlier transaction, so the event is looked up by the
 * op's hash in the blocks before the receipt.
 */
import { type Log, type Provider, type TransactionReceipt } from 'ethers';
/** EntryPoint v0.7's per-op outcome events. */
export declare const ENTRY_POINT_EVENTS_ABI: readonly ["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)", "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)", "event PostOpRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)", "event UserOperationPrefundTooLow(bytes32 indexed userOpHash, address indexed sender, uint256 nonce)"];
/** What the EntryPoint's logs say became of one op. */
export type UserOperationOutcome = {
    status: 'success';
}
/**
 * `revertData` is the op's raw revert (from `UserOperationRevertReason` or,
 * prefixed in `stage: 'postOp'`, `PostOpRevertReason`); empty when the
 * EntryPoint gave none (`UserOperationPrefundTooLow`, out of gas).
 */
 | {
    status: 'reverted';
    stage: 'execution' | 'postOp' | 'prefund';
    revertData: string;
}
/** No `UserOperationEvent` for this op among the logs. */
 | {
    status: 'missing';
};
/** The outcome of the op `userOpHash` among an EntryPoint's logs (other ops and other contracts are skipped). */
export declare function userOperationOutcome(logs: readonly Pick<Log, 'address' | 'topics' | 'data'>[], entryPoint: string, userOpHash: string): UserOperationOutcome;
/**
 * The op did not succeed, or its fate cannot be read.
 *   - `reverted`: mined, and its call reverted. `revertData` is the raw revert:
 *     decode it with the target's ABI (`identityRevertName` for the identity
 *     registry), and never log its arguments.
 *   - `not_executed`: the transaction is mined but carries no event for the op,
 *     and none is found in the blocks before it.
 *   - `unknown`: no receipt in time, or the chain could not be read; the op may
 *     still land. Re-read before retrying: a resend of the same op is refused
 *     by its nonce once the first lands.
 */
export declare class UserOperationFailedError extends Error {
    readonly reason: 'reverted' | 'not_executed' | 'unknown';
    readonly userOpHash: string;
    readonly txHash: string;
    readonly revertData: string;
    readonly stage: 'execution' | 'postOp' | 'prefund' | null;
    constructor(reason: 'reverted' | 'not_executed' | 'unknown', userOpHash: string, txHash: string, revertData?: string, stage?: 'execution' | 'postOp' | 'prefund' | null);
}
/** Blocks searched before the receipt for an op the plane may have sent in an earlier transaction; public Base nodes cap `eth_getLogs` at about 200 blocks. */
export declare const USER_OPERATION_LOOKBACK_BLOCKS = 200;
/** How long to wait for the receipt of a relayed op before answering `unknown`. */
export declare const USER_OPERATION_RECEIPT_TIMEOUT_MS = 120000;
export interface ConfirmUserOperationOptions {
    provider: Pick<Provider, 'waitForTransaction' | 'getTransactionReceipt' | 'getLogs'>;
    entryPoint: string;
    userOpHash: string;
    /** The transaction the op was sent in (the relay's `txHash`, or the self-bundled `handleOps`). */
    txHash: string;
    timeoutMs?: number | undefined;
    lookbackBlocks?: number | undefined;
}
/**
 * Wait for `txHash` and return the receipt of the transaction that ran the op
 * successfully, or throw `UserOperationFailedError`. Never resolves on a
 * mined transaction alone.
 */
export declare function confirmUserOperation(opts: ConfirmUserOperationOptions): Promise<TransactionReceipt>;
export interface FindUserOperationOptions {
    provider: Pick<Provider, 'getBlockNumber' | 'getTransactionReceipt' | 'getLogs'>;
    entryPoint: string;
    userOpHash: string;
    /** The plane's transaction, when its answer named one; only for the error. */
    txHash?: string | undefined;
    lookbackBlocks?: number | undefined;
    /** How long to keep looking: a send the node took is mined seconds later. Defaults to the receipt wait. */
    timeoutMs?: number | undefined;
    /** Between looks; 2 s by default (Base's block time). */
    pollIntervalMs?: number | undefined;
}
/**
 * Look an op up by its hash in the latest blocks, after a relay answer that
 * does not say whether it was sent (`relay_failed`, answered as soon as the
 * node's send fails, before anything could be mined): it looks again every
 * `pollIntervalMs` until `timeoutMs`. Returns the receipt of the transaction
 * that ran it successfully; throws `UserOperationFailedError` `reverted` when
 * it ran and reverted, and `unknown` when it is not found in time (it may
 * still land) or the chain could not be read.
 */
export declare function findUserOperation(opts: FindUserOperationOptions): Promise<TransactionReceipt>;
//# sourceMappingURL=userOpOutcome.d.ts.map