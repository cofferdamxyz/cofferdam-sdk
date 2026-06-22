// Integration tests for NativeAccountProvider.
//
// These need:
//   1. base-anvil running at http://127.0.0.1:8545 (chainId 31337)
//   2. The ERC-4337 stack + authority modules deployed via
//        cd ../base-contracts && yarn deploy:local
//      which writes CofferdamAccountFactory4337 / CofferdamPaymaster /
//      WebAuthnPasskeyAuthority to base-contracts/deployments/localhost.json
//   3. base-anvil rich wallet #0 as the PoC deployer (funds deploys + paymaster)
//
// If any are missing the describe block skips (so plain `vitest` stays green in
// CI without a chain). Set COFFERDAM_LOCAL_INTEGRATION=1 to force-fail instead.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'
import { JsonRpcProvider, Wallet as EthWallet, Contract as EthContract } from 'ethers'
import {
  NativeAccountProvider,
  DeterministicPasskeySigner,
  encodePasskeyConfig,
  decodeAndVerifySessionAttestation,
  PasskeyCapReachedError,
  SignInRejected,
} from '../src/index.js'

const RPC_URL = 'http://127.0.0.1:8545'
const CHAIN_ID = 31337
const DEPLOYER_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' // base-anvil rich #2

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
    'base-contracts',
    'deployments',
    'localhost.json',
  )
  if (!fs.existsSync(p)) return null
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  const factory = raw.CofferdamAccountFactory4337?.address
  const paymaster = raw.CofferdamPaymaster?.address
  const passkeyModule = raw.PasskeyAuthority?.address ?? raw.WebAuthnPasskeyAuthority?.address
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

const FACTORY_ABI: string[] = [
  'function getAddress(address initialModule, bytes initialConfig, bytes32 salt) view returns (address)',
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
        ? `base-anvil not reachable at ${RPC_URL} on chain ${CHAIN_ID}`
        : 'ERC-4337 stack missing from base-contracts/deployments/localhost.json — run `yarn deploy:local`'
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

    // The attestation is a real passkey-signed envelope over the response
    // fields; it decodes, verifies, and pins to this session's scope/account.
    expect(result.attestation).toMatch(/^csa1:/)
    const att = decodeAndVerifySessionAttestation(result.attestation, {
      expect: { scope: 'offshoresync', accountAddress: result.accountAddress, chainId: CHAIN_ID },
    })
    expect(att.alg).toBe('p256')
    expect(att.appPseudonym).toBe(result.appPseudonym)

    // Cross-check the off-chain counterfactual against the on-chain factory.
    const { keccak256, toUtf8Bytes } = await import('ethers')
    const salt = keccak256(toUtf8Bytes(`cofferdam-native-account|${userId}`))
    const pub = await new DeterministicPasskeySigner(userId).publicKey()
    const config = encodePasskeyConfig(pub)

    const chain = new JsonRpcProvider(RPC_URL)
    const factory = new EthContract(dep.factory, FACTORY_ABI, chain)
    const onchain: string = await factory.getFunction('getAddress')(dep.passkeyModule, config, salt)
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

    const chain = new JsonRpcProvider(RPC_URL)
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
    const chain = new JsonRpcProvider(RPC_URL)
    const deployer = new EthWallet(DEPLOYER_PK, chain)
    await (await deployer.sendTransaction({ to: dep.paymaster, value: 1_000_000_000_000_000_000n })).wait()

    expect(await chain.getBalance(accountAddress)).toBe(0n)

    // No-op call (value 0, empty data) to a benign target — exercises the full
    // ERC-4337 path: deploy → passkey validate → paymaster sponsor → execute.
    const receipt = await provider.sendTransaction({ to: deployer.address, value: 0n })
    expect(receipt.status).toBe(1)

    // The account paid no fee: still zero balance.
    expect(await chain.getBalance(accountAddress)).toBe(0n)
  }, 90_000)

  it('signIn() rejects a user excluded by policy.allowedCountries', async () => {
    if (skip) return

    const provider = mkProvider(`nap-policy-${Date.now()}`, { verifiedClaims: { country: 'BR' } })
    await expect(provider.signIn({ allowedCountries: ['US'] })).rejects.toBeInstanceOf(SignInRejected)
  }, 30_000)

  it('lists, adds (with ≤3 cap), revokes authorities and resolves a backup device id', async () => {
    if (skip) return

    // Pre-fund the account (no paymaster for management txs in local dev).
    const chain = new JsonRpcProvider(RPC_URL)
    const deployer = new EthWallet(DEPLOYER_PK, chain)

    const base = `nap-multi-${Date.now()}`
    const primary = mkProvider(base, { usePaymaster: false })
    const accountAddress = await primary.getAccountAddress()
    await (await deployer.sendTransaction({ to: accountAddress, value: 1_000_000_000_000_000_000n })).wait()
    await primary.ensureDeployed()

    // Bootstrap: a single self passkey at id 0.
    let list = await primary.listAuthorities()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 0,
      tier: 'high',
      kind: 'passkey',
      active: true,
      isPasskey: true,
      isSelf: true,
    })
    expect(await primary.resolveOwnAuthorityId()).toBe(0)

    // Add a backup passkey (a different key) → id 1.
    const backupSigner = new DeterministicPasskeySigner(`${base}-backup`)
    const backupPub = await backupSigner.publicKey()
    await primary.addBackupPasskey(backupPub)

    expect((await primary.getAuthorityState()).passkeyCount).toBe(2)
    list = await primary.listAuthorities()
    expect(list).toHaveLength(2)
    expect(list[1]).toMatchObject({ id: 1, tier: 'high', isPasskey: true, active: true, isSelf: false })

    // A provider standing in for the BACKUP device: same account, backup key.
    const backup = mkProvider(`${base}-backup-dev`, {
      signer: backupSigner,
      accountAddress,
      usePaymaster: false,
    })
    expect(await backup.resolveOwnAuthorityId()).toBe(1)
    const backupView = await backup.listAuthorities()
    expect(backupView.find((r) => r.id === 1)?.isSelf).toBe(true)
    expect(backupView.find((r) => r.id === 0)?.isSelf).toBe(false)

    // The backup device authorises adding a 3rd passkey with ITS own id.
    const thirdPub = await new DeterministicPasskeySigner(`${base}-third`).publicKey()
    await backup.addBackupPasskey(thirdPub, { authorityId: 1 })
    expect((await primary.getAuthorityState()).passkeyCount).toBe(3)

    // Cap: a 4th is refused client-side, before spending any gas.
    const fourthPub = await new DeterministicPasskeySigner(`${base}-fourth`).publicKey()
    await expect(primary.addBackupPasskey(fourthPub)).rejects.toBeInstanceOf(PasskeyCapReachedError)

    // Revoking the backup (id 1) frees a slot and marks it inactive.
    await primary.revokeAuthority(1)
    expect((await primary.getAuthorityState()).passkeyCount).toBe(2)
    expect((await primary.listAuthorities()).find((r) => r.id === 1)?.active).toBe(false)

    // The revoked backup device can no longer resolve its (active) id.
    await expect(backup.resolveOwnAuthorityId()).rejects.toThrow(/not an active authority/)
  }, 240_000)
})
