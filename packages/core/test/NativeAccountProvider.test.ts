// Integration tests for NativeAccountProvider.
//
// These need:
//   1. anvil-zksync running at http://127.0.0.1:8011 (chainId 260)
//   2. The native-AA stack + authority modules deployed via
//        cd ../contracts && yarn deploy:auth:local && yarn deploy:native:local
//      which writes CofferdamAccountFactory / CofferdamPaymaster / PasskeyAuthority
//      to contracts/deployments/inMemoryNode.json
//   3. anvil-zksync rich wallet #0 as the PoC deployer (funds deploys + paymaster)
//
// If any are missing the describe block skips (so plain `vitest` stays green in
// CI without a chain). Set COFFERDAM_LOCAL_INTEGRATION=1 to force-fail instead.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'
import { Provider as ZkProvider, Wallet as ZkWallet, Contract as ZkContract } from 'zksync-ethers'
import {
  NativeAccountProvider,
  DeterministicPasskeySigner,
  encodePasskeyConfig,
  SignInRejected,
} from '../src/index.js'

const RPC_URL = 'http://127.0.0.1:8011'
const CHAIN_ID = 260
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil-zksync rich #0

interface NativeDeployment {
  factory: string
  paymaster: string
  passkeyModule: string
}

function loadDeployment(): NativeDeployment | null {
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
  const factory = raw.CofferdamAccountFactory?.address
  const paymaster = raw.CofferdamPaymaster?.address
  const passkeyModule = raw.PasskeyAuthority?.address
  if (!factory || !paymaster || !passkeyModule) return null
  return { factory, paymaster, passkeyModule }
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

const FACTORY_ABI = [
  'function getAccountAddress(bytes32 salt, address initialModule, bytes initialConfig) view returns (address)',
]

describe('NativeAccountProvider (integration)', () => {
  let dep: NativeDeployment
  let skip = false
  let skipReason = ''

  beforeAll(async () => {
    const d = loadDeployment()
    const node = await nodeReachable()
    if (!d || !node) {
      skip = true
      skipReason = !node
        ? `anvil-zksync not reachable at ${RPC_URL} on chain ${CHAIN_ID}`
        : 'native-AA stack missing from contracts/deployments/inMemoryNode.json — run `yarn deploy:auth:local && yarn deploy:native:local`'
      if (FORCE) throw new Error(`[NativeAccountProvider integration] ${skipReason}`)
      // eslint-disable-next-line no-console
      console.warn(`[NativeAccountProvider integration] skipping: ${skipReason}`)
      return
    }
    dep = d
  })

  function mkProvider(userId: string, extra: Partial<Record<string, unknown>> = {}) {
    return new NativeAccountProvider({
      scope: 'offshoresync',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: {
        factory: dep.factory,
        paymaster: dep.paymaster,
        passkeyModule: dep.passkeyModule,
      },
      userId,
      deployerPrivateKey: DEPLOYER_PK,
      ...extra,
    })
  }

  it('signIn() derives a passkey-governed counterfactual address matching the factory', async () => {
    if (skip) return

    const userId = `nap-cf-${Date.now()}`
    const provider = mkProvider(userId)
    const result = await provider.signIn({})

    expect(result.accountAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(result.authority).toEqual({ kind: 'passkey', tier: 'high' })
    expect(result.appPseudonym).toMatch(/^cd_pseudo_[0-9a-f]{24}$/)
    expect(result.sessionToken).toMatch(/^native\./)

    // Cross-check the off-chain counterfactual against the on-chain factory.
    const { keccak256, toUtf8Bytes } = await import('ethers')
    const salt = keccak256(toUtf8Bytes(`cofferdam-native-account|${userId}`))
    const pub = await new DeterministicPasskeySigner(userId).publicKey()
    const config = encodePasskeyConfig(pub)

    const chain = new ZkProvider(RPC_URL)
    const factory = new ZkContract(dep.factory, FACTORY_ABI, chain)
    const onchain: string = await factory.getAccountAddress(salt, dep.passkeyModule, config)
    expect(result.accountAddress.toLowerCase()).toBe(onchain.toLowerCase())
  }, 30_000)

  it('getAccountAddress() is deterministic per (userId) and distinct across users', async () => {
    if (skip) return

    const userId = `nap-determ-${Date.now()}`
    const a = await mkProvider(userId).getAccountAddress()
    const b = await mkProvider(userId).getAccountAddress()
    const c = await mkProvider(`${userId}-other`).getAccountAddress()

    expect(a).toBe(b)
    expect(a).not.toBe(c)
  }, 30_000)

  it('ensureDeployed() deploys the account and reflects on-chain authority state', async () => {
    if (skip) return

    const provider = mkProvider(`nap-deploy-${Date.now()}`)
    expect(await provider.isDeployed()).toBe(false)

    const addr = await provider.ensureDeployed()
    expect(await provider.isDeployed()).toBe(true)

    const chain = new ZkProvider(RPC_URL)
    expect(await chain.getCode(addr)).not.toBe('0x')

    const state = await provider.getAuthorityState()
    expect(state.accountDeployed).toBe(true)
    expect(state.passkeyCount).toBe(1)
    expect(state.upgradeLocked).toBe(true)
    expect(state.active).toEqual({ kind: 'passkey', tier: 'high' })
  }, 60_000)

  it('sendTransaction() runs a paymaster-sponsored op from a ZERO-balance account', async () => {
    if (skip) return

    const provider = mkProvider(`nap-send-${Date.now()}`)
    const accountAddress = await provider.getAccountAddress()

    // Fund the paymaster (the sponsor), NOT the account.
    const chain = new ZkProvider(RPC_URL)
    const deployer = new ZkWallet(DEPLOYER_PK, chain)
    await (await deployer.sendTransaction({ to: dep.paymaster, value: 1_000_000_000_000_000_000n })).wait()

    expect(await chain.getBalance(accountAddress)).toBe(0n)

    // No-op call (value 0, empty data) to a benign target — exercises the full
    // bootloader path: deploy → passkey validate → paymaster pay → execute.
    const receipt = await provider.sendTransaction({ to: deployer.address, value: 0n })
    expect(receipt.status).toBe(1)

    // The account paid no fee: still zero balance, nonce advanced to 1.
    expect(await chain.getBalance(accountAddress)).toBe(0n)
    expect(await chain.getTransactionCount(accountAddress)).toBe(1)
  }, 90_000)

  it('signIn() rejects a user excluded by policy.allowedCountries', async () => {
    if (skip) return

    const provider = mkProvider(`nap-policy-${Date.now()}`, { verifiedClaims: { country: 'BR' } })
    await expect(provider.signIn({ allowedCountries: ['US'] })).rejects.toBeInstanceOf(SignInRejected)
  }, 30_000)
})
