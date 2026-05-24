// adminTxQueue — Phase α-2 internal helper.
//
// Why this exists
// ───────────────
// `LocalChainProvider.signIn()` may send 1–2 admin-signed txs (pre-fund +
// bindNullifier). When a consumer app instantiates *multiple* providers
// against the same admin EOA — e.g. the capacitor-minimal demo runs three
// providers in parallel for recruiter / funder / worker — those instances
// independently call `provider.getTransactionCount(admin, "pending")` to
// pick a nonce.
//
// On a real public RPC (ZKSync Era Sepolia in particular) the pending-nonce
// view is eventually-consistent: a tx that just mined may not yet be
// reflected when the *next* provider asks for `getTransactionCount`. The
// second tx then signs a stale nonce and the sequencer rejects it with
// "nonce too low. allowed nonce range: N - N+20, actual: N-1". On
// anvil-zksync this never reproduces because the in-memory node updates
// pending state synchronously.
//
// What this module provides
// ─────────────────────────
// A module-level singleton, keyed by `${rpcUrl}:${adminAddress}`, that:
//
//   1. Serializes every admin tx through a per-key promise chain — so
//      concurrent provider instances against the same admin EOA never
//      race on nonce assignment, regardless of how many `LocalChainProvider`
//      instances the consumer app spins up.
//
//   2. Tracks the "next nonce to use" locally, seeded on first use from
//      `getTransactionCount(admin, "latest")`. Each successful submit bumps
//      the counter by one, so we never re-read the (potentially stale)
//      pending nonce from the RPC.
//
//   3. Recovers from desync once: if the sequencer rejects with
//      `nonce too low` / `nonce too high` / `nonce already used`, we
//      refresh from `latest`, advance the counter, and retry the same
//      operation a single time. Still throws on the second failure.
//
// Scope
// ─────
// This is purely internal to `LocalChainProvider`. It is *not* a public
// API, not exported from the package root, and does not attempt to be a
// general-purpose nonce manager. β/v2 admin operations move server-side
// (LayerZero DVN delivery, Cofferdam TEE attestation) where this concern
// disappears entirely.

import type { Provider as ZkProvider, Wallet as ZkWallet } from 'zksync-ethers'

const queues = new Map<string, Promise<unknown>>()
const nonces = new Map<string, number>()

function queueKey(rpcUrl: string, adminAddress: string): string {
  return `${rpcUrl}::${adminAddress.toLowerCase()}`
}

function isStaleNonceError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { message?: unknown; shortMessage?: unknown; code?: unknown }
  const haystack = `${typeof e.message === 'string' ? e.message : ''} ${
    typeof e.shortMessage === 'string' ? e.shortMessage : ''
  }`.toLowerCase()
  return (
    haystack.includes('nonce too low') ||
    haystack.includes('nonce too high') ||
    haystack.includes('nonce already used') ||
    haystack.includes('replacement transaction underpriced') ||
    haystack.includes('already known')
  )
}

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
export async function runAdminTx<T>(
  rpcUrl: string,
  provider: ZkProvider,
  adminWallet: ZkWallet,
  op: (nonce: number) => Promise<T>,
): Promise<T> {
  const key = queueKey(rpcUrl, adminWallet.address)
  const prev = queues.get(key) ?? Promise.resolve()

  const next = prev.then(async () => {
    let nonce = nonces.get(key)
    if (nonce == null) {
      nonce = await provider.getTransactionCount(adminWallet.address, 'latest')
      nonces.set(key, nonce)
    }

    try {
      const result = await op(nonce)
      nonces.set(key, nonce + 1)
      return result
    } catch (err) {
      if (!isStaleNonceError(err)) throw err
      // Refresh from the canonical latest-block view and retry once.
      const refreshed = await provider.getTransactionCount(adminWallet.address, 'latest')
      nonces.set(key, refreshed)
      const result = await op(refreshed)
      nonces.set(key, refreshed + 1)
      return result
    }
  })

  // Don't poison the queue with errors — a failed op shouldn't block the
  // next caller. Subsequent ops will still run; the failure surfaces to
  // the original caller via the `next` promise we return below.
  queues.set(
    key,
    next.catch(() => {}),
  )

  return next as Promise<T>
}

/**
 * Test-only: reset the in-memory queue + nonce cache. Not exported from
 * the package root.
 */
export function _resetAdminTxQueue(): void {
  queues.clear()
  nonces.clear()
}
