// Integration tests for LocalChainProvider.
//
// These tests need:
//   1. anvil-zksync running at http://127.0.0.1:8011 (chainId 260)
//   2. OffshoreSyncReceiver + OffshoreSyncEscrow deployed via
//      `cd ../contracts && yarn deploy:v1-zksync:local`
//   3. A funded rich-wallet admin key (anvil-zksync's wallet #0 is the default)
//
// If any of those are missing, the entire describe block is skipped (rather
// than failed) so plain `vitest` runs in CI without a chain stay green. Set
// COFFERDAM_LOCAL_INTEGRATION=1 to force-fail instead, which is what the
// `test:integration` CI lane will use once it exists.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'
import { Provider as ZkProvider, Wallet as ZkWallet, Contract as ZkContract } from 'zksync-ethers'
import { LocalChainProvider, SignInRejected } from '../src/index.js'

const RPC_URL = 'http://127.0.0.1:8011'
const CHAIN_ID = 260
const ADMIN_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil-zksync rich #0

// Read the deployed addresses produced by `yarn deploy:v1-zksync:local`.
function loadDeployment(): { receiver: string; escrow: string } | null {
  const p = path.resolve(
    new URL(import.meta.url).pathname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'contracts',
    'deployments',
    'inMemoryNode.json',
  )
  if (!fs.existsSync(p)) return null
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (!raw.OffshoreSyncReceiver?.address || !raw.OffshoreSyncEscrow?.address) {
    return null
  }
  return {
    receiver: raw.OffshoreSyncReceiver.address,
    escrow: raw.OffshoreSyncEscrow.address,
  }
}

async function nodeReachable(): Promise<boolean> {
  try {
    const r = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
    })
    if (!r.ok) return false
    const body = (await r.json()) as { result?: string }
    return body.result?.toLowerCase() === '0x' + CHAIN_ID.toString(16)
  } catch {
    return false
  }
}

const FORCE = process.env.COFFERDAM_LOCAL_INTEGRATION === '1'

describe('LocalChainProvider (integration)', () => {
  let deployment: { receiver: string; escrow: string }
  let skip = false
  let skipReason = ''

  beforeAll(async () => {
    const dep = loadDeployment()
    const node = await nodeReachable()
    if (!dep || !node) {
      skip = true
      skipReason = !node
        ? `anvil-zksync not reachable at ${RPC_URL} on chain ${CHAIN_ID}`
        : 'contracts/deployments/inMemoryNode.json missing — run `yarn deploy:v1-zksync:local`'
      if (FORCE) {
        throw new Error(`[LocalChainProvider integration] ${skipReason}`)
      }
      // eslint-disable-next-line no-console
      console.warn(`[LocalChainProvider integration] skipping: ${skipReason}`)
      return
    }
    deployment = dep
  })

  it('signIn() derives a stable EOA from mockUserId and binds it on-chain', async () => {
    if (skip) return

    const provider = new LocalChainProvider({
      scope: 'offshoresync',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: deployment,
      mockUserId: `lcp-test-user-${Date.now()}`, // fresh so we don't collide with prior runs
      adminPrivateKey: ADMIN_PK,
    })

    const result = await provider.signIn({})
    expect(result.accountAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(result.appPseudonym).toMatch(/^cd_pseudo_[0-9a-f]{24}$/)
    expect(result.sessionToken).toMatch(/^local\./)

    // Verify the bind landed on-chain.
    const chain = new ZkProvider(RPC_URL)
    const receiver = new ZkContract(
      deployment.receiver,
      ['function isAccountBound(address) view returns (bool)'],
      chain,
    )
    const bound: boolean = await receiver.isAccountBound(result.accountAddress)
    expect(bound).toBe(true)
  }, 30_000)

  it('signIn() is deterministic for a given (scope, mockUserId)', async () => {
    if (skip) return

    const mockUserId = `lcp-determ-${Date.now()}`
    const a = new LocalChainProvider({
      scope: 'offshoresync',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: deployment,
      mockUserId,
      // No admin key on these — we only want to test address/pseudonym
      // determinism; binding is a separate concern proven by the first test.
    })
    const b = new LocalChainProvider({
      scope: 'offshoresync',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: deployment,
      mockUserId,
    })

    const r1 = await a.signIn({})
    const r2 = await b.signIn({})

    expect(r1.accountAddress).toBe(r2.accountAddress)
    expect(r1.appPseudonym).toBe(r2.appPseudonym)
  }, 30_000)

  it('signIn() returns different pseudonyms across scopes (per-app unlinkability)', async () => {
    if (skip) return

    const mockUserId = `lcp-scope-${Date.now()}`
    const offshoresync = new LocalChainProvider({
      scope: 'offshoresync',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: deployment,
      mockUserId,
    })
    const pnp = new LocalChainProvider({
      scope: 'pnp-club',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: deployment,
      mockUserId,
    })

    const r1 = await offshoresync.signIn({})
    const r2 = await pnp.signIn({})

    // accountAddress is per-user (chain identity), so it's the SAME across scopes.
    expect(r1.accountAddress).toBe(r2.accountAddress)
    // appPseudonym is per-(scope, user), so it must differ — that's the
    // unlinkability invariant.
    expect(r1.appPseudonym).not.toBe(r2.appPseudonym)
  }, 30_000)

  it('signIn() pre-funds the derived account when prefundWei is set', async () => {
    if (skip) return

    const mockUserId = `lcp-prefund-${Date.now()}`
    const provider = new LocalChainProvider({
      scope: 'offshoresync',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: deployment,
      mockUserId,
      adminPrivateKey: ADMIN_PK,
      prefundWei: 1_000_000_000_000_000_000n, // 1 ETH
    })

    const result = await provider.signIn({})
    const chain = new ZkProvider(RPC_URL)
    const bal = await chain.getBalance(result.accountAddress)
    expect(bal).toBeGreaterThanOrEqual(1_000_000_000_000_000_000n)
  }, 30_000)

  it('signIn() rejects user when policy.allowedCountries excludes their country', async () => {
    if (skip) return

    const provider = new LocalChainProvider({
      scope: 'us-only',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: deployment,
      mockUserId: `lcp-policy-${Date.now()}`,
      verifiedClaims: { country: 'BR' },
    })

    await expect(provider.signIn({ allowedCountries: ['US'] })).rejects.toBeInstanceOf(
      SignInRejected,
    )
  }, 30_000)

  it('signIn() works without admin key (returns unbound account)', async () => {
    if (skip) return

    const mockUserId = `lcp-no-admin-${Date.now()}`
    const provider = new LocalChainProvider({
      scope: 'offshoresync',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: deployment,
      mockUserId,
    })

    const result = await provider.signIn({})
    expect(result.accountAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)

    const chain = new ZkProvider(RPC_URL)
    const receiver = new ZkContract(
      deployment.receiver,
      ['function isAccountBound(address) view returns (bool)'],
      chain,
    )
    const bound: boolean = await receiver.isAccountBound(result.accountAddress)
    expect(bound).toBe(false)
  }, 30_000)

  it('end-to-end: signed-in user can post a job contract to the escrow', async () => {
    if (skip) return

    const userMockId = `lcp-e2e-${Date.now()}`
    const provider = new LocalChainProvider({
      scope: 'offshoresync',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: deployment,
      mockUserId: userMockId,
      adminPrivateKey: ADMIN_PK,
      prefundWei: 2_000_000_000_000_000_000n, // 2 ETH
    })

    const result = await provider.signIn({})

    // Recreate the same user wallet client-side to call postContract.
    // In a real app, the SDK would expose a signer; for the PoC we just
    // re-derive (the keypair is deterministic from mockUserId).
    const { Wallet: ZkW, Contract: ZkC } = await import('zksync-ethers')
    const { keccak256, toUtf8Bytes } = await import('ethers')

    // Recover the same deterministic private key the provider used.
    const ABI = [
      'function postContract(bytes32 termsHash) payable returns (uint256)',
      'event ContractPosted(uint256 indexed contractId, address indexed recruiter, uint256 amount, bytes32 termsHash)',
    ]
    const chain = new ZkProvider(RPC_URL)

    // Re-derive the user's private key using the same algorithm as the provider.
    const userPk = await deriveDeterministicPk(userMockId)
    const userWallet = new ZkW(userPk, chain)
    expect(userWallet.address.toLowerCase()).toBe(result.accountAddress.toLowerCase())

    const escrow = new ZkC(deployment.escrow, ABI, userWallet)
    const termsHash = keccak256(toUtf8Bytes('job-terms-blob-e2e-v1'))
    const tx = await escrow.postContract(termsHash, {
      value: 1_000_000_000_000_000_000n, // 1 ETH
    })
    const receipt = await tx.wait()
    expect(receipt.status).toBe(1)
  }, 60_000)
})

// Mirror the LocalChainProvider's deterministic-key derivation so the e2e
// test can produce the same address client-side. (Identical to the function
// inside the provider; we don't export it from the public SDK surface.)
async function deriveDeterministicPk(mockUserId: string): Promise<string> {
  const salt = 'cofferdam-local-privatekey-v1'
  const keyMaterial = new TextEncoder().encode(salt)
  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(mockUserId) as BufferSource)
  const bytes = new Uint8Array(sig)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0')
  return '0x' + hex
}
