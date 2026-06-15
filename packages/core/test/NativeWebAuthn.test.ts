// Tests for the WebAuthn passkey path: the SDK's WebAuthn assertion encoding +
// NativeAccountProvider driving a real-passkey-shaped account on-chain.
//
// Unit tests run anywhere. The integration block needs anvil-zksync at :8011
// with the native-AA stack + WebAuthnPasskeyAuthority deployed (yarn
// deploy:auth:local && yarn deploy:native:local). It skips gracefully if not.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'
import { p256 } from '@noble/curves/p256'
import { keccak256, toUtf8Bytes, getBytes } from 'ethers'
import { Provider as ZkProvider, Wallet as ZkWallet, Contract as ZkContract } from 'zksync-ethers'

import {
  NativeAccountProvider,
  WebAuthnPasskeySigner,
  softwareWebAuthnAuthenticator,
  softwareWebAuthnPublicKey,
  encodeWebAuthnInnerSignature,
  p256PublicKeyFromDer,
  derSignatureToRS,
  encodePasskeyConfig,
} from '../src/index.js'

const RPC_URL = 'http://127.0.0.1:8011'
const CHAIN_ID = 260
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// ── Unit ─────────────────────────────────────────────────────────────────────

describe('WebAuthn assertion encoding', () => {
  const priv = p256.utils.randomPrivateKey()

  it('softwareWebAuthnPublicKey matches p256.getPublicKey coordinates', () => {
    const pub = softwareWebAuthnPublicKey(priv)
    const raw = p256.getPublicKey(priv, false)
    expect(pub.qx).toBe('0x' + Buffer.from(raw.slice(1, 33)).toString('hex'))
    expect(pub.qy).toBe('0x' + Buffer.from(raw.slice(33, 65)).toString('hex'))
  })

  it('encodes a synthesised assertion into a decodable WebAuthnAuth blob', async () => {
    const authn = softwareWebAuthnAuthenticator(priv)
    const challenge = getBytes(keccak256(toUtf8Bytes('digest-1')))
    const assertion = await authn.authenticate(challenge)
    const inner = encodeWebAuthnInnerSignature(assertion)
    // 6-field ABI tuple: r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON.
    expect(inner.startsWith('0x')).toBe(true)
    expect(inner.length).toBeGreaterThan(2 + 6 * 64)
    // clientDataJSON must embed the base64url challenge so the indices are valid.
    const json = typeof assertion.clientDataJSON === 'string' ? assertion.clientDataJSON : ''
    expect(json).toContain('"type":"webauthn.get"')
    expect(json).toContain('"challenge":"')
  })

  it('derSignatureToRS yields low-s 32-byte r/s', async () => {
    const authn = softwareWebAuthnAuthenticator(priv)
    const assertion = await authn.authenticate(getBytes(keccak256(toUtf8Bytes('d2'))))
    const { r, s } = derSignatureToRS(assertion.signature)
    expect(r).toMatch(/^0x[0-9a-f]{64}$/)
    expect(s).toMatch(/^0x[0-9a-f]{64}$/)
    expect(BigInt(s) <= p256.CURVE.n / 2n).toBe(true)
  })

  it('p256PublicKeyFromDer round-trips a DER SPKI public key', () => {
    // Build a DER SPKI: fixed P-256 prefix + uncompressed point.
    const point = p256.getPublicKey(priv, false) // 0x04 || X || Y
    const SPKI_PREFIX = Uint8Array.from([
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
      0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ])
    const der = new Uint8Array(SPKI_PREFIX.length + point.length)
    der.set(SPKI_PREFIX, 0)
    der.set(point, SPKI_PREFIX.length)
    const pub = p256PublicKeyFromDer(der)
    expect(pub).toEqual(softwareWebAuthnPublicKey(priv))
  })
})

// ── Integration ───────────────────────────────────────────────────────────────

interface NativeWebAuthnDeployment {
  factory: string
  paymaster: string
  webauthnModule: string
}

function loadDeployment(): NativeWebAuthnDeployment | null {
  const p = path.resolve(
    new URL(import.meta.url).pathname,
    '..', '..', '..', '..', '..',
    'contracts', 'deployments', 'inMemoryNode.json',
  )
  if (!fs.existsSync(p)) return null
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  const factory = raw.CofferdamAccountFactory?.address
  const paymaster = raw.CofferdamPaymaster?.address
  const webauthnModule = raw.WebAuthnPasskeyAuthority?.address
  if (!factory || !paymaster || !webauthnModule) return null
  return { factory, paymaster, webauthnModule }
}

async function nodeReachable(): Promise<boolean> {
  try {
    const r = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
    })
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

describe('NativeAccountProvider with WebAuthn passkey (integration)', () => {
  let dep: NativeWebAuthnDeployment
  let skip = false

  beforeAll(async () => {
    const d = loadDeployment()
    const node = await nodeReachable()
    if (!d || !node) {
      skip = true
      const reason = !node
        ? `anvil-zksync not reachable at ${RPC_URL}`
        : 'WebAuthn native stack missing from inMemoryNode.json — run deploy:auth:local && deploy:native:local'
      if (FORCE) throw new Error(`[NativeWebAuthn integration] ${reason}`)
      // eslint-disable-next-line no-console
      console.warn(`[NativeWebAuthn integration] skipping: ${reason}`)
      return
    }
    dep = d
  })

  function mkProvider(userId: string) {
    // Deterministic P-256 key per user so the counterfactual is stable.
    const priv = getBytes(keccak256(toUtf8Bytes(`webauthn-test-key:${userId}`)))
    const signer = new WebAuthnPasskeySigner(
      softwareWebAuthnPublicKey(priv),
      softwareWebAuthnAuthenticator(priv),
    )
    const provider = new NativeAccountProvider({
      scope: 'offshoresync',
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: {
        factory: dep.factory,
        paymaster: dep.paymaster,
        passkeyModule: dep.webauthnModule,
      },
      userId,
      signer,
      deployerPrivateKey: DEPLOYER_PK,
      usePaymaster: true,
    })
    return { provider, priv }
  }

  it('counterfactual matches the factory for the WebAuthn module + pubkey config', async () => {
    if (skip) return
    const userId = `wa-cf-${Date.now()}`
    const { provider, priv } = mkProvider(userId)
    const addr = await provider.getAccountAddress()

    const salt = keccak256(toUtf8Bytes(`cofferdam-native-account|${userId}`))
    const config = encodePasskeyConfig(softwareWebAuthnPublicKey(priv))
    const chain = new ZkProvider(RPC_URL)
    const factory = new ZkContract(dep.factory, FACTORY_ABI, chain)
    const onchain: string = await factory.getAccountAddress(salt, dep.webauthnModule, config)
    expect(addr.toLowerCase()).toBe(onchain.toLowerCase())
  }, 30_000)

  it('deploys + runs a WebAuthn-authorised paymaster-sponsored tx from zero balance', async () => {
    if (skip) return
    const { provider } = mkProvider(`wa-send-${Date.now()}`)
    const session = await provider.signIn({})
    expect(session.authority).toEqual({ kind: 'passkey', tier: 'high' })

    const accountAddress = session.accountAddress
    await provider.ensureDeployed()
    expect(await provider.isDeployed()).toBe(true)

    const chain = new ZkProvider(RPC_URL)
    const deployer = new ZkWallet(DEPLOYER_PK, chain)
    await (await deployer.sendTransaction({ to: dep.paymaster, value: 1_000_000_000_000_000_000n })).wait()

    expect(await chain.getBalance(accountAddress)).toBe(0n)
    const receipt = await provider.sendTransaction({ to: accountAddress, value: 0n })
    expect(receipt.status).toBe(1)
    expect(await chain.getBalance(accountAddress)).toBe(0n)
    expect(await chain.getTransactionCount(accountAddress)).toBe(1)
  }, 90_000)
})
