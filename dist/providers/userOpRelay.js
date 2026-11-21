// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0
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
import { concat } from 'ethers';
/** Route on the plane that relays a signed op. */
export const USER_OPERATION_PATH = '/v1/aa/user-operation';
export function serializeUserOperation(op) {
    return {
        sender: op.sender,
        nonce: op.nonce.toString(),
        initCode: op.initCode,
        callData: op.callData,
        accountGasLimits: op.accountGasLimits,
        preVerificationGas: op.preVerificationGas.toString(),
        gasFees: op.gasFees,
        paymasterAndData: op.paymasterAndData,
        signature: op.signature,
    };
}
/**
 * `initCode` for EntryPoint v0.7: the factory address followed by the
 * `deployAccount(initialModule, initialConfig, salt)` calldata. The EntryPoint
 * calls the factory through its SenderCreator and requires the returned
 * address to equal `sender` (AA14 otherwise).
 */
export function buildInitCode(factory, factoryIface, initialModule, initialConfig, initialPermission, salt) {
    return concat([
        factory,
        factoryIface.encodeFunctionData('deployAccount', [initialModule, initialConfig, initialPermission, salt]),
    ]);
}
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
export class UserOpRelayError extends Error {
    code;
    status;
    txHash;
    constructor(code, message, status, 
    /** The mined transaction, for `user_op_reverted`. */
    txHash = null) {
        super(`[cofferdam-sdk] relay ${code}: ${message}`);
        this.code = code;
        this.status = status;
        this.txHash = txHash;
        this.name = 'UserOpRelayError';
    }
}
/**
 * Whether a refusal may follow a send the node took: a 5xx other than
 * `preflight_unavailable` (503, whose pre-flight sent nothing).
 */
export function mayHaveBeenSent(err) {
    return err.status >= 500 && err.code !== 'preflight_unavailable';
}
/**
 * POST the signed op to the plane; resolves with the `handleOps` tx hash once
 * the plane accepted it (`202`). Acceptance is not success: confirm the op
 * with `confirmUserOperation`, as `NativeAccountProvider.sendTransaction` does.
 */
export async function relayUserOperation(opts) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const url = opts.relayerUrl.replace(/\/+$/, '') + USER_OPERATION_PATH;
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            entryPoint: opts.entryPoint,
            ...(opts.chainId !== undefined ? { chainId: opts.chainId } : {}),
            userOp: serializeUserOperation(opts.userOp),
        }),
    });
    const body = (await res.json().catch(() => ({})));
    if (!res.ok || !body.ok || !body.txHash) {
        throw new UserOpRelayError(body.error ?? `http_${res.status}`, body.message ?? `relayer answered ${res.status}`, res.status, typeof body.txHash === 'string' ? body.txHash : null);
    }
    const receipt = body.receipt === 'success' || body.receipt === 'pending' || body.receipt === 'unknown' ? body.receipt : null;
    return { txHash: body.txHash, receipt };
}
//# sourceMappingURL=userOpRelay.js.map