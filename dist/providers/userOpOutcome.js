// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0
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
import { Interface } from 'ethers';
/** EntryPoint v0.7's per-op outcome events. */
export const ENTRY_POINT_EVENTS_ABI = [
    'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
    'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
    'event PostOpRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
    'event UserOperationPrefundTooLow(bytes32 indexed userOpHash, address indexed sender, uint256 nonce)',
];
const EVENTS_IFACE = new Interface(ENTRY_POINT_EVENTS_ABI);
const USER_OPERATION_EVENT_TOPIC = EVENTS_IFACE.getEvent('UserOperationEvent').topicHash;
/** The outcome of the op `userOpHash` among an EntryPoint's logs (other ops and other contracts are skipped). */
export function userOperationOutcome(logs, entryPoint, userOpHash) {
    const ep = entryPoint.toLowerCase();
    const hash = userOpHash.toLowerCase();
    let success = null;
    let failure = null;
    for (const log of logs) {
        if (log.address.toLowerCase() !== ep || log.topics[1]?.toLowerCase() !== hash)
            continue;
        let parsed;
        try {
            parsed = EVENTS_IFACE.parseLog({ topics: [...log.topics], data: log.data });
        }
        catch {
            continue;
        }
        if (!parsed)
            continue;
        if (parsed.name === 'UserOperationEvent')
            success = Boolean(parsed.args.getValue('success'));
        else if (parsed.name === 'UserOperationRevertReason')
            failure ??= { stage: 'execution', revertData: parsed.args.getValue('revertReason') };
        else if (parsed.name === 'PostOpRevertReason')
            failure ??= { stage: 'postOp', revertData: parsed.args.getValue('revertReason') };
        else if (parsed.name === 'UserOperationPrefundTooLow')
            failure ??= { stage: 'prefund', revertData: '0x' };
    }
    if (success === null)
        return { status: 'missing' };
    if (success)
        return { status: 'success' };
    return { status: 'reverted', ...(failure ?? { stage: 'execution', revertData: '0x' }) };
}
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
export class UserOperationFailedError extends Error {
    reason;
    userOpHash;
    txHash;
    revertData;
    stage;
    constructor(reason, userOpHash, txHash, revertData = '0x', stage = null) {
        super(`[cofferdam-sdk] user operation ${reason}${stage ? ` (${stage})` : ''}: op ${userOpHash}, tx ${txHash}`);
        this.reason = reason;
        this.userOpHash = userOpHash;
        this.txHash = txHash;
        this.revertData = revertData;
        this.stage = stage;
        this.name = 'UserOperationFailedError';
    }
}
/** Blocks searched before the receipt for an op the plane may have sent in an earlier transaction; public Base nodes cap `eth_getLogs` at about 200 blocks. */
export const USER_OPERATION_LOOKBACK_BLOCKS = 200;
/** How long to wait for the receipt of a relayed op before answering `unknown`. */
export const USER_OPERATION_RECEIPT_TIMEOUT_MS = 120_000;
/**
 * Wait for `txHash` and return the receipt of the transaction that ran the op
 * successfully, or throw `UserOperationFailedError`. Never resolves on a
 * mined transaction alone.
 */
export async function confirmUserOperation(opts) {
    const { provider, entryPoint, userOpHash, txHash } = opts;
    let receipt;
    try {
        receipt = await provider.waitForTransaction(txHash, 1, opts.timeoutMs ?? USER_OPERATION_RECEIPT_TIMEOUT_MS);
    }
    catch {
        throw new UserOperationFailedError('unknown', userOpHash, txHash);
    }
    if (!receipt)
        throw new UserOperationFailedError('unknown', userOpHash, txHash);
    if (receipt.status === 1) {
        const outcome = userOperationOutcome(receipt.logs, entryPoint, userOpHash);
        if (outcome.status === 'success')
            return receipt;
        if (outcome.status === 'reverted') {
            throw new UserOperationFailedError('reverted', userOpHash, txHash, outcome.revertData, outcome.stage);
        }
    }
    // `handleOps` reverted, or ran without this op: look for the op in the
    // blocks before, where an earlier send of the same op may have landed.
    const toBlock = receipt.blockNumber;
    const fromBlock = Math.max(0, toBlock - (opts.lookbackBlocks ?? USER_OPERATION_LOOKBACK_BLOCKS));
    let found;
    try {
        found = await provider.getLogs({ address: entryPoint, topics: [USER_OPERATION_EVENT_TOPIC, userOpHash], fromBlock, toBlock });
    }
    catch {
        throw new UserOperationFailedError('unknown', userOpHash, txHash);
    }
    const event = found.find((l) => !l.removed);
    if (!event)
        throw new UserOperationFailedError('not_executed', userOpHash, txHash);
    let earlier;
    try {
        earlier = await provider.getTransactionReceipt(event.transactionHash);
    }
    catch {
        earlier = null;
    }
    if (!earlier)
        throw new UserOperationFailedError('unknown', userOpHash, event.transactionHash);
    const outcome = userOperationOutcome(earlier.logs, entryPoint, userOpHash);
    if (outcome.status === 'success')
        return earlier;
    if (outcome.status === 'reverted') {
        throw new UserOperationFailedError('reverted', userOpHash, earlier.hash, outcome.revertData, outcome.stage);
    }
    throw new UserOperationFailedError('unknown', userOpHash, earlier.hash);
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
export async function findUserOperation(opts) {
    const { provider, entryPoint, userOpHash } = opts;
    const txHash = opts.txHash ?? '';
    const deadline = Date.now() + (opts.timeoutMs ?? USER_OPERATION_RECEIPT_TIMEOUT_MS);
    const interval = opts.pollIntervalMs ?? 2_000;
    let event;
    for (;;) {
        try {
            const toBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(0, toBlock - (opts.lookbackBlocks ?? USER_OPERATION_LOOKBACK_BLOCKS));
            const found = await provider.getLogs({ address: entryPoint, topics: [USER_OPERATION_EVENT_TOPIC, userOpHash], fromBlock, toBlock });
            event = found.find((l) => !l.removed);
        }
        catch {
            // A failed read is looked at again until the deadline.
        }
        const left = deadline - Date.now();
        if (event || left <= 0)
            break;
        await new Promise((r) => setTimeout(r, Math.min(interval, left)));
    }
    if (!event)
        throw new UserOperationFailedError('unknown', userOpHash, txHash);
    let receipt;
    try {
        receipt = await provider.getTransactionReceipt(event.transactionHash);
    }
    catch {
        receipt = null;
    }
    if (!receipt)
        throw new UserOperationFailedError('unknown', userOpHash, event.transactionHash);
    const outcome = userOperationOutcome(receipt.logs, entryPoint, userOpHash);
    if (outcome.status === 'success')
        return receipt;
    if (outcome.status === 'reverted') {
        throw new UserOperationFailedError('reverted', userOpHash, receipt.hash, outcome.revertData, outcome.stage);
    }
    throw new UserOperationFailedError('unknown', userOpHash, receipt.hash);
}
//# sourceMappingURL=userOpOutcome.js.map