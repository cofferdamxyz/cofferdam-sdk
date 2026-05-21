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

  // ────────────────────────────────────────────────────────────────────────
  // Corporate flow (α-3): three signed-in users — recruiter (HR) drafts the
  // contract, funder (Finance) funds it, worker eventually receives the
  // settled payment. Exercises the full off-chain-identity → on-chain
  // multi-party flow that real enterprise hires will use.
  // ────────────────────────────────────────────────────────────────────────

  it('corporate flow: three signed-in users complete draft → fund → settle', async () => {
    if (skip) return

    const stamp = Date.now()
    const recruiterId = `lcp-corp-recruiter-${stamp}`
    const funderId = `lcp-corp-funder-${stamp}`
    const workerId = `lcp-corp-worker-${stamp}`

    // Each role gets its own LocalChainProvider. Identity binding goes
    // through the same admin key (simulating the future α-3 LZ delivery
    // / v2 TEE attestation); pre-funding gives recruiter + funder ETH to
    // pay gas / lock funds. Worker gets no pre-fund (they only call
    // checkIn/checkOut, which Cofferdam will sponsor via paymaster later).
    const mkProvider = (mockUserId: string, prefund: bigint) =>
      new LocalChainProvider({
        scope: 'offshoresync',
        rpcUrl: RPC_URL,
        chainId: CHAIN_ID,
        contracts: deployment,
        mockUserId,
        adminPrivateKey: ADMIN_PK,
        prefundWei: prefund,
      })

    const recruiterRes = await mkProvider(recruiterId, 500_000_000_000_000_000n).signIn({}) // 0.5 ETH
    const funderRes = await mkProvider(funderId, 2_000_000_000_000_000_000n).signIn({})    // 2 ETH (must cover amount + gas)
    const workerRes = await mkProvider(workerId, 100_000_000_000_000_000n).signIn({})       // 0.1 ETH (gas only)

    // The three accounts must be distinct (different mockUserId → different
    // deterministic keys).
    expect(recruiterRes.accountAddress).not.toBe(funderRes.accountAddress)
    expect(recruiterRes.accountAddress).not.toBe(workerRes.accountAddress)
    expect(funderRes.accountAddress).not.toBe(workerRes.accountAddress)

    // Re-derive each role's wallet (same pattern as the single-user e2e test).
    const { Wallet: ZkW, Contract: ZkC } = await import('zksync-ethers')
    const { keccak256, toUtf8Bytes } = await import('ethers')
    const chain = new ZkProvider(RPC_URL)

    const recruiterWallet = new ZkW(await deriveDeterministicPk(recruiterId), chain)
    const funderWallet = new ZkW(await deriveDeterministicPk(funderId), chain)
    const workerWallet = new ZkW(await deriveDeterministicPk(workerId), chain)

    // Sanity: the provider-returned addresses match our re-derived ones.
    expect(recruiterWallet.address.toLowerCase()).toBe(recruiterRes.accountAddress.toLowerCase())
    expect(funderWallet.address.toLowerCase()).toBe(funderRes.accountAddress.toLowerCase())
    expect(workerWallet.address.toLowerCase()).toBe(workerRes.accountAddress.toLowerCase())

    const ESCROW_ABI = [
      'function postContractIntent(bytes32 termsHash, uint256 amount, address designatedFunder) returns (uint256)',
      'function fundContract(uint256 contractId) payable',
      'function awardContract(uint256 contractId, address workerAccount)',
      'function checkIn(uint256 contractId)',
      'function checkOut(uint256 contractId)',
      'function settle(uint256 contractId)',
      'function getContract(uint256 contractId) view returns (tuple(address recruiter, address designatedFunder, address funder, address worker, uint256 amount, bytes32 termsHash, uint64 draftedAt, uint64 postedAt, uint64 awardedAt, uint64 checkedInAt, uint64 checkedOutAt, uint8 status))',
      'event ContractDrafted(uint256 indexed contractId, address indexed recruiter, address indexed designatedFunder, uint256 amount, bytes32 termsHash)',
      'event ContractFunded(uint256 indexed contractId, address indexed funder, uint256 amount)',
    ]

    const escrowAsRecruiter = new ZkC(deployment.escrow, ESCROW_ABI, recruiterWallet)
    const escrowAsFunder = new ZkC(deployment.escrow, ESCROW_ABI, funderWallet)
    const escrowAsWorker = new ZkC(deployment.escrow, ESCROW_ABI, workerWallet)
    const escrowRead = new ZkC(deployment.escrow, ESCROW_ABI, chain)

    const termsHash = keccak256(toUtf8Bytes(`corp-job-terms-${stamp}`))
    const amount = 1_000_000_000_000_000_000n // 1 ETH

    // ── Step 1: Recruiter (HR) posts the intent. NO funds transferred. ──
    const draftTx = await escrowAsRecruiter.postContractIntent(
      termsHash,
      amount,
      funderRes.accountAddress, // designatedFunder = Finance
    )
    const draftReceipt = await draftTx.wait()
    expect(draftReceipt.status).toBe(1)

    // Extract contractId from the ContractDrafted event.
    const draftedEvent = escrowAsRecruiter.interface.getEvent('ContractDrafted')
    expect(draftedEvent).toBeTruthy()
    const draftedTopic = draftedEvent!.topicHash
    const draftedLog = draftReceipt.logs.find(
      (l: { topics: ReadonlyArray<string>; address: string }) =>
        l.topics[0] === draftedTopic &&
        l.address.toLowerCase() === (deployment.escrow as string).toLowerCase(),
    )
    expect(draftedLog).toBeTruthy()
    const parsed = escrowAsRecruiter.interface.parseLog(draftedLog!)
    const contractId = parsed!.args.contractId as bigint
    expect(contractId).toBeGreaterThan(0n)

    // After draft: status == 8 (Drafted), no funds locked.
    let c = await escrowRead.getContract(contractId)
    expect(c.status).toBe(8n) // Drafted
    expect(c.designatedFunder.toLowerCase()).toBe(funderRes.accountAddress.toLowerCase())
    expect(c.funder).toBe('0x0000000000000000000000000000000000000000')

    // ── Step 2: Funder (Finance) funds the draft. ──
    const fundTx = await escrowAsFunder.fundContract(contractId, { value: amount })
    const fundReceipt = await fundTx.wait()
    expect(fundReceipt.status).toBe(1)

    // After fund: status == 0 (Posted), funder == finance address, escrow holds the ETH.
    c = await escrowRead.getContract(contractId)
    expect(c.status).toBe(0n) // Posted
    expect(c.funder.toLowerCase()).toBe(funderRes.accountAddress.toLowerCase())
    expect(c.amount).toBe(amount)

    // ── Step 3: Recruiter awards the worker. ──
    const awardTx = await escrowAsRecruiter.awardContract(contractId, workerRes.accountAddress)
    await awardTx.wait()
    c = await escrowRead.getContract(contractId)
    expect(c.status).toBe(1n) // Awarded
    expect(c.worker.toLowerCase()).toBe(workerRes.accountAddress.toLowerCase())

    // ── Step 4 + 5: Worker checks in, then out. ──
    await (await escrowAsWorker.checkIn(contractId)).wait()
    await (await escrowAsWorker.checkOut(contractId)).wait()
    c = await escrowRead.getContract(contractId)
    expect(c.status).toBe(3n) // CheckedOut

    // ── Step 6: Settle — anyone can call. Use recruiter as the "keeper" for
    // this PoC (in production: Cofferdam keeper bot or paymaster). The
    // worker's balance grows by exactly `amount`.
    const workerBalBefore = await chain.getBalance(workerRes.accountAddress)
    await (await escrowAsRecruiter.settle(contractId)).wait()
    const workerBalAfter = await chain.getBalance(workerRes.accountAddress)
    expect(workerBalAfter - workerBalBefore).toBe(amount)

    c = await escrowRead.getContract(contractId)
    expect(c.status).toBe(4n) // Settled
    expect(c.amount).toBe(0n)
  }, 90_000)
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
