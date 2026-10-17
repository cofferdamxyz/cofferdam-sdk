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
/** The plane refused or failed to relay the op. `code` is its error id. */
export declare class UserOpRelayError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number);
}
export interface RelayUserOperationOptions {
    /** Plane base URL, e.g. `https://cofferdam-api.example.workers.dev`. */
    relayerUrl: string;
    userOp: PackedUserOperation;
    /** EntryPoint the op was hashed against; the plane refuses any other. */
    entryPoint: string;
    fetchImpl?: typeof fetch;
}
/** POST the signed op to the plane; resolves with the `handleOps` tx hash. */
export declare function relayUserOperation(opts: RelayUserOperationOptions): Promise<{
    txHash: string;
}>;
//# sourceMappingURL=userOpRelay.d.ts.map