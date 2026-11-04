import type { JsonRpcProvider, Wallet } from 'ethers';
/**
 * Run an admin-signed tx operation under the per-(rpcUrl, admin) queue,
 * passing it the nonce to use. The operation MUST set the returned nonce
 * on its tx (e.g. via `wallet.sendTransaction({ nonce, ... })`) so the
 * locally-tracked counter stays in sync with what's actually broadcast.
 *
 * Failure recovery: on a stale-nonce error the queue refreshes from
 * `getTransactionCount(admin, "latest")` once and re-runs `op` a single
 * time. A second failure propagates to the caller.
 */
export declare function runAdminTx<T>(rpcUrl: string, provider: JsonRpcProvider, adminWallet: Wallet, op: (nonce: number) => Promise<T>): Promise<T>;
/**
 * Test-only: reset the in-memory queue + nonce cache. Not exported from
 * the package root.
 */
export declare function _resetAdminTxQueue(): void;
//# sourceMappingURL=adminTxQueue.d.ts.map