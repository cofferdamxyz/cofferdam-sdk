// NativeAccountProvider — native ZKSync Era Account Abstraction provider.
//
// The production-shaped sibling of `LocalChainProvider`. Where LocalChainProvider
// returns a plain EOA, this provider bridges the SDK to the native-AA contract
// stack (contracts/v2/auth):
//
//   - CofferdamAccountFactory  — CREATE2 factory for CofferdamSmartAccount.
//   - CofferdamSmartAccount    — the native `IAccount` wallet, governed by a
//                                High-tier P-256 passkey authority.
//   - CofferdamPaymaster       — general-flow gas sponsor (zero-balance UX).
//   - PasskeyAuthority         — stateless High-tier P-256 module.
//
// What `signIn()` does:
//   1. Get the user's P-256 passkey public key (via a pluggable `PasskeySigner`;
//      default is a deterministic software key for PoC).
//   2. Build the account's bootstrap `config = abi.encode(qx, qy)` and a stable
//      CREATE2 `salt` from the user id.
//   3. Derive the COUNTERFACTUAL account address off-chain (matching the on-chain
//      factory's `getAccountAddress`), so the wallet has an address before it is
//      deployed.
//   4. Optionally deploy the account now (PoC: via `deployerPrivateKey`).
//
// `sendTransaction()` submits a native type-113 AA transaction signed by the
// passkey and (by default) sponsored by the paymaster, so the user pays no gas.

import { AbiCoder, getBytes, keccak256, toUtf8Bytes, Contract as EthContract, Interface } from 'ethers'
import {
  Provider as ZkProvider,
  Wallet as ZkWallet,
  Contract as ZkContract,
  EIP712Signer,
  utils,
  types,
} from 'zksync-ethers'

import { derivePseudonym, deriveScopeKey } from '../identity/pseudonym.js'
import {
  DeterministicPasskeySigner,
  encodePasskeyConfig,
  type PasskeySigner,
  type P256PublicKey,
} from '../identity/passkey.js'
import { bytesToBase64url } from '../identity/webauthn.js'
import { signSessionAttestation } from '../identity/sessionAttestation.js'
import { SignInRejected } from './MockProvider.js'
import type {
  AuthorityKind,
  AuthorityState,
  AuthorityTier,
  CofferdamProvider,
  DeviceCapability,
  NetworkMode,
  SignInErrorCode,
  SignInPolicy,
  SignInResponse,
  VerifiedClaims,
} from '../types.js'

export { SignInRejected } from './MockProvider.js'

const abi = AbiCoder.defaultAbiCoder()

/** Minimal factory ABI — only the surface this provider calls. */
const FACTORY_ABI = [
  'function aaBytecodeHash() view returns (bytes32)',
  'function getAccountAddress(bytes32 salt, address initialModule, bytes initialConfig) view returns (address)',
  'function deployAccount(bytes32 salt, address initialModule, bytes initialConfig) returns (address)',
] as const

/** Minimal account ABI for on-chain authority reads + management self-calls. */
const ACCOUNT_ABI = [
  'function passkeyCount() view returns (uint256)',
  'function upgradeLocked() view returns (bool)',
  'function authorityCount() view returns (uint256)',
  'function getAuthority(uint256 authorityId) view returns (address module, uint8 tier, bool active, bytes config)',
  'function addAuthority(address newModule, bytes newConfig) returns (uint256 newAuthorityId)',
  'function revokeAuthority(uint256 targetId)',
] as const

/** Encoder for the management self-call calldata (addAuthority / revokeAuthority). */
const ACCOUNT_IFACE = new Interface(ACCOUNT_ABI as unknown as string[])

/**
 * Client-side mirror of the on-chain `MAX_PASSKEYS` cap (AuthorityManagerBase).
 * The contract is the real enforcer; this lets the UI fail fast without gas.
 */
export const MAX_PASSKEYS = 3

/** Map the on-chain `Tier` enum (None/LowUntrusted/LowManaged/High) to the SDK tier. */
const TIER_BY_ENUM: Record<number, AuthorityTier | null> = {
  0: null, // Tier.None — a never-populated slot.
  1: 'low_untrusted',
  2: 'low_managed',
  3: 'high',
}

function kindForRecord(tier: AuthorityTier, isPasskey: boolean): AuthorityKind {
  if (isPasskey || tier === 'high') return 'passkey'
  if (tier === 'low_managed') return 'polis_sso'
  return 'password' // best-effort label for an untrusted low-tier authority
}

/** A single entry in the account's on-chain authority registry. */
export interface AuthorityRecord {
  /** Index in the registry — the `authorityId` used to sign / revoke. */
  id: number
  /** Authority module contract address. */
  module: string
  /** Trust tier of this authority. */
  tier: AuthorityTier
  /** Best-effort authority kind for UI labelling. */
  kind: AuthorityKind
  /** False once revoked. */
  active: boolean
  /** True when the module is the configured passkey module (a device passkey). */
  isPasskey: boolean
  /** True when this record's config matches THIS provider's signer public key. */
  isSelf: boolean
  /** Opaque per-account authority config blob (abi.encode(qx,qy) for passkeys). */
  config: string
}

/**
 * Thrown client-side before submitting a 4th passkey, mirroring the contract's
 * `PasskeyCapReached` revert so the UI can fail fast without spending gas.
 */
export class PasskeyCapReachedError extends Error {
  constructor(
    message = `[cofferdam-sdk] cannot add another passkey: the account is at the ${MAX_PASSKEYS}-passkey cap (revoke one first).`,
  ) {
    super(message)
    this.name = 'PasskeyCapReachedError'
  }
}

export interface NativeAccountProviderConfig {
  /** Consumer-app identifier (e.g. 'offshoresync'). */
  scope: string
  /** Per-scope salt for pseudonym derivation. Defaults to a value from `scope`. */
  scopeSalt?: string

  /** RPC URL of the ZKSync Era node. Local default: 'http://127.0.0.1:8011'. */
  rpcUrl: string
  /** Chain id. anvil-zksync = 260; ZKSync Era Sepolia = 300. */
  chainId: number

  contracts: {
    /** `CofferdamAccountFactory` address. */
    factory: string
    /** `PasskeyAuthority` (High-tier) module address. */
    passkeyModule: string
    /** `CofferdamPaymaster` address. Required for sponsored (gasless) txs. */
    paymaster?: string
    /**
     * `CofferdamSmartAccount` ZKSync bytecode hash. Optional: if omitted it is
     * read once from `factory.aaBytecodeHash()` and cached. Provide it to make
     * `signIn()` fully offline (no RPC round-trip for the counterfactual address).
     */
    aaBytecodeHash?: string
  }

  /** Stable per-user id → deterministic CREATE2 salt (and PoC passkey). */
  userId?: string

  /**
   * Pluggable passkey signer. Defaults to a deterministic software signer keyed
   * on `userId` (PoC). Swap for a hardware/WebAuthn signer in production.
   */
  signer?: PasskeySigner

  /**
   * PoC deployer key. Deploying the counterfactual account is a normal tx that
   * needs gas; this key pays for it (and may fund the paymaster). NEVER ship
   * this in a client — production deploys via a relayer or the first sponsored
   * op.
   */
  deployerPrivateKey?: string

  /**
   * Authority id this provider's signer occupies on the account. The bootstrap
   * passkey is id 0 (the default). A backup device should set this, pass
   * `authorityId` per tx, or call `resolveOwnAuthorityId()` to discover it.
   */
  authorityId?: number

  /**
   * Override the counterfactual account address. A backup device does NOT derive
   * the account (its key differs from the bootstrap key); it is told the
   * canonical address out-of-band (the QR handoff / reconciliation flow) and
   * passes it here so all reads/txs target the shared account.
   */
  accountAddress?: string

  /** Sponsor user txs via the paymaster. Default: true when `paymaster` is set. */
  usePaymaster?: boolean

  /** Deploy the account during `signIn()` if not yet on-chain (needs deployer key). */
  autoDeploy?: boolean

  /** Gas limit for AA txs when estimation is skipped/fails. Default 20_000_000. */
  defaultGasLimit?: bigint

  verified?: boolean
  verifiedClaims?: Partial<VerifiedClaims>
  latencyMs?: number
}

interface ResolvedConfig {
  scope: string
  scopeSalt: string
  rpcUrl: string
  chainId: number
  contracts: {
    factory: string
    passkeyModule: string
    paymaster?: string
    aaBytecodeHash?: string
  }
  userId: string
  deployerPrivateKey: string | null
  usePaymaster: boolean
  authorityId: number
  autoDeploy: boolean
  defaultGasLimit: bigint
  verified: boolean
  verifiedClaims: VerifiedClaims
  latencyMs: number
}

/** Parameters for an account-routed transaction. */
export interface NativeTxRequest {
  to: string
  data?: string
  value?: bigint
  /** Override gas limit; otherwise estimated (with a default fallback). */
  gasLimit?: bigint
  /** Override paymaster sponsorship for this tx. Defaults to provider setting. */
  usePaymaster?: boolean
  /**
   * Authority id whose passkey signs this tx. Defaults to the provider's
   * configured `authorityId` (0 for the bootstrap device).
   */
  authorityId?: number
}

export class NativeAccountProvider implements CofferdamProvider {
  readonly mode: NetworkMode

  private readonly config: ResolvedConfig
  private readonly chainProvider: ZkProvider
  private readonly signer: PasskeySigner

  private cachedPublicKey: P256PublicKey | null = null
  private cachedBytecodeHash: string | null = null
  private cachedAddress: string | null = null

  constructor(config: NativeAccountProviderConfig) {
    this.config = {
      scope: config.scope,
      scopeSalt: config.scopeSalt ?? `native-salt:${config.scope}`,
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      contracts: {
        factory: config.contracts.factory,
        passkeyModule: config.contracts.passkeyModule,
        paymaster: config.contracts.paymaster,
        aaBytecodeHash: config.contracts.aaBytecodeHash,
      },
      userId: config.userId ?? 'native-user-default',
      deployerPrivateKey: config.deployerPrivateKey ?? null,
      usePaymaster: config.usePaymaster ?? Boolean(config.contracts.paymaster),
      authorityId: config.authorityId ?? 0,
      autoDeploy: config.autoDeploy ?? false,
      defaultGasLimit: config.defaultGasLimit ?? 20_000_000n,
      verified: config.verified ?? true,
      verifiedClaims: {
        country: 'BR',
        olderThan: 18,
        ofacClear: true,
        proofTimestamp: Date.now(),
        ...config.verifiedClaims,
      },
      latencyMs: config.latencyMs ?? 0,
    }
    // chainId 260 = local anvil-zksync; 300 = ZKSync Era Sepolia.
    this.mode = this.config.chainId === 300 ? 'testnet' : 'local'
    this.chainProvider = new ZkProvider(this.config.rpcUrl)
    this.signer = config.signer ?? new DeterministicPasskeySigner(this.config.userId)
    if (this.cachedBytecodeHash === null && this.config.contracts.aaBytecodeHash) {
      this.cachedBytecodeHash = this.config.contracts.aaBytecodeHash
    }
    // A backup device is handed the canonical address; it cannot derive it (its
    // key differs from the bootstrap key). Pin it so all reads/txs target it.
    if (config.accountAddress) this.cachedAddress = config.accountAddress
  }

  // ── CofferdamProvider ───────────────────────────────────────────────────────

  async signIn(policy: SignInPolicy): Promise<SignInResponse> {
    await sleep(this.config.latencyMs)
    this.enforcePolicy(policy)

    const accountAddress = await this.getAccountAddress()

    let deployed = await this.isDeployed()
    if (!deployed && this.config.autoDeploy) {
      await this.ensureDeployed()
      deployed = true
    }

    const appPseudonym = await derivePseudonym(this.config.scopeSalt, accountAddress)
    const scopeKey = await deriveScopeKey(`native-user:${this.config.userId}`, this.config.scope)
    const issuedAt = Date.now()

    // Passkey-signed envelope binding the security-relevant response fields, so
    // a consumer can cryptographically verify the session origin (the holder of
    // the account's passkey authorised it). Prompts the authenticator (biometric
    // in production). Verify with `decodeAndVerifySessionAttestation`.
    const attestation = await signSessionAttestation({
      signer: this.signer,
      publicKey: await this.publicKey(),
      fields: {
        scope: this.config.scope,
        appPseudonym,
        accountAddress,
        chainId: this.config.chainId,
        verified: this.config.verified,
        issuedAt,
      },
    })

    return {
      appPseudonym,
      accountAddress,
      verified: this.config.verified,
      verifiedClaims: this.config.verified ? this.config.verifiedClaims : null,
      scopeKey,
      sessionToken: encodeSessionToken({
        scope: this.config.scope,
        appPseudonym,
        accountAddress,
        chainId: this.config.chainId,
        issuedAt,
      }),
      attestation,
      authority: { kind: 'passkey', tier: 'high' },
      migrationStatus: 'enrolled',
      accountDeployed: deployed,
    }
  }

  signOut(): void {
    // No persistent state beyond the cached derivations; chain state is on-chain.
  }

  async getAuthorityState(): Promise<AuthorityState> {
    const accountAddress = await this.getAccountAddress()
    const deployed = await this.isDeployed()

    if (deployed) {
      const account = new ZkContract(accountAddress, ACCOUNT_ABI, this.chainProvider)
      const [passkeyCount, upgradeLocked] = await Promise.all([
        account.passkeyCount() as Promise<bigint>,
        account.upgradeLocked() as Promise<boolean>,
      ])
      return {
        active: { kind: 'passkey', tier: 'high' },
        passkeyCount: Number(passkeyCount),
        upgradeLocked,
        accountDeployed: true,
        migrationStatus: 'enrolled',
      }
    }

    // Counterfactual: the bootstrap config holds exactly one passkey and the
    // ratchet is conceptually locked (a passkey governs the account on deploy).
    return {
      active: { kind: 'passkey', tier: 'high' },
      passkeyCount: 1,
      upgradeLocked: true,
      accountDeployed: false,
      migrationStatus: 'enrolled',
    }
  }

  deviceCapability(): DeviceCapability {
    // A passkey signer is present; surface depends on the host app.
    return {
      hasPlatformAuthenticator: true,
      inBrowserPasskeyReliable: false,
      nativeAppReachable: false,
    }
  }

  // ── Account lifecycle ─────────────────────────────────────────────────────

  /** The counterfactual smart-account address for the configured user. */
  async getAccountAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress
    const bytecodeHash = await this.aaBytecodeHash()
    const salt = this.salt()
    const input = await this.bootstrapInput()
    this.cachedAddress = utils.create2Address(
      this.config.contracts.factory,
      bytecodeHash,
      salt,
      input,
    )
    return this.cachedAddress
  }

  /** Whether the smart account has been deployed on-chain. */
  async isDeployed(): Promise<boolean> {
    const addr = await this.getAccountAddress()
    const code = await this.chainProvider.getCode(addr)
    return code !== undefined && code !== null && code !== '0x'
  }

  /**
   * Deploy the counterfactual account via the factory (idempotent). Requires
   * `deployerPrivateKey`. Returns the account address.
   */
  async ensureDeployed(): Promise<string> {
    const addr = await this.getAccountAddress()
    if (await this.isDeployed()) return addr
    if (!this.config.deployerPrivateKey) {
      throw new Error(
        '[cofferdam-sdk] ensureDeployed: no deployerPrivateKey configured. ' +
          'Deploying the counterfactual account needs a funded signer.',
      )
    }
    const deployer = new ZkWallet(this.config.deployerPrivateKey, this.chainProvider)
    const factory = new ZkContract(this.config.contracts.factory, FACTORY_ABI, deployer)
    const config = await this.bootstrapConfig()
    const tx = await factory.deployAccount(this.salt(), this.config.contracts.passkeyModule, config)
    await tx.wait()
    return addr
  }

  // ── Transactions ───────────────────────────────────────────────────────────

  /**
   * Submit a native type-113 AA transaction from the smart account, signed by
   * the passkey authority (authority id 0) and, by default, sponsored by the
   * paymaster. Auto-deploys the account first if a deployer key is configured.
   */
  async sendTransaction(req: NativeTxRequest): Promise<types.TransactionReceipt> {
    const accountAddress = await this.getAccountAddress()
    if (!(await this.isDeployed())) {
      if (!this.config.deployerPrivateKey) {
        throw new Error(
          '[cofferdam-sdk] sendTransaction: account is not deployed and no ' +
            'deployerPrivateKey is set to deploy it. Call ensureDeployed() first.',
        )
      }
      await this.ensureDeployed()
    }

    const usePaymaster = req.usePaymaster ?? this.config.usePaymaster
    const paymaster = this.config.contracts.paymaster
    if (usePaymaster && !paymaster) {
      throw new Error('[cofferdam-sdk] sendTransaction: usePaymaster requires contracts.paymaster.')
    }

    const gasPrice = await this.chainProvider.getGasPrice()
    const base: types.TransactionRequest = {
      type: utils.EIP712_TX_TYPE,
      from: accountAddress,
      to: req.to,
      data: req.data ?? '0x',
      value: req.value ?? 0n,
      chainId: BigInt(this.config.chainId),
      nonce: await this.chainProvider.getTransactionCount(accountAddress),
      gasLimit: req.gasLimit ?? this.config.defaultGasLimit,
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice,
      customData: { gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT } as types.Eip712Meta,
    }
    if (usePaymaster && paymaster) {
      base.customData!.paymasterParams = utils.getPaymasterParams(paymaster, {
        type: 'General',
        innerInput: new Uint8Array(),
      })
    }

    // Estimate gas unless the caller pinned a limit. Estimation ignores the
    // validation magic, so a dummy signature suffices; the signed digest below
    // is recomputed with the final gas limit before the real passkey signature.
    if (req.gasLimit === undefined) {
      base.gasLimit = await this.estimateGas(base)
    }

    const authorityId = req.authorityId ?? this.config.authorityId
    const signedHash = EIP712Signer.getSignedDigest(base) as string
    const innerSignature = await this.signer.sign(getBytes(signedHash))
    base.customData!.customSignature = abi.encode(
      ['uint256', 'bytes'],
      [authorityId, innerSignature],
    )

    const sent = await this.chainProvider.broadcastTransaction(utils.serializeEip712(base as never))
    return sent.wait()
  }

  // ── Authority management (multi-device) ─────────────────────────────────────

  /**
   * Enumerate the account's on-chain authority registry: every device passkey
   * (High) plus any managed/Self authorities. Skips never-populated (`None`)
   * slots. On a counterfactual (not-yet-deployed) account, returns the single
   * bootstrap passkey at id 0.
   */
  async listAuthorities(): Promise<AuthorityRecord[]> {
    const passkeyModule = this.config.contracts.passkeyModule.toLowerCase()
    const ownConfig = (await this.bootstrapConfig()).toLowerCase()

    if (!(await this.isDeployed())) {
      return [
        {
          id: 0,
          module: this.config.contracts.passkeyModule,
          tier: 'high',
          kind: 'passkey',
          active: true,
          isPasskey: true,
          isSelf: true,
          config: ownConfig,
        },
      ]
    }

    const account = new ZkContract(await this.getAccountAddress(), ACCOUNT_ABI, this.chainProvider)
    const count = Number((await account.authorityCount()) as bigint)
    const records: AuthorityRecord[] = []
    for (let id = 0; id < count; id++) {
      const [module, tierNum, active, config] = (await account.getAuthority(id)) as [
        string,
        bigint,
        boolean,
        string,
      ]
      const tier = TIER_BY_ENUM[Number(tierNum)]
      if (!tier) continue // Tier.None — skip.
      const isPasskey = module.toLowerCase() === passkeyModule
      records.push({
        id,
        module,
        tier,
        kind: kindForRecord(tier, isPasskey),
        active,
        isPasskey,
        isSelf: isPasskey && config.toLowerCase() === ownConfig,
        config,
      })
    }
    return records
  }

  /**
   * Resolve the authority id whose config matches THIS provider's signer public
   * key. The bootstrap device is id 0; a backup device discovers its own id
   * (1/2) here so it can sign management txs. Throws if the key is not an active
   * authority on the account.
   */
  async resolveOwnAuthorityId(): Promise<number> {
    const mine = (await this.listAuthorities()).find((r) => r.isSelf && r.active)
    if (!mine) {
      throw new Error(
        "[cofferdam-sdk] resolveOwnAuthorityId: this device's passkey is not an " +
          'active authority on the account (was it revoked, or is this the wrong account?).',
      )
    }
    return mine.id
  }

  /**
   * Add a backup device passkey as a new High-tier authority via a self-call to
   * `addAuthority`, authorised by `authorityId` (a High signer; default the
   * provider's). Fails fast with `PasskeyCapReachedError` if already at the cap.
   */
  async addBackupPasskey(
    pub: P256PublicKey,
    opts: { authorityId?: number } = {},
  ): Promise<types.TransactionReceipt> {
    const state = await this.getAuthorityState()
    if (state.passkeyCount >= MAX_PASSKEYS) throw new PasskeyCapReachedError()

    const data = ACCOUNT_IFACE.encodeFunctionData('addAuthority', [
      this.config.contracts.passkeyModule,
      encodePasskeyConfig(pub),
    ])
    return this.sendTransaction({
      to: await this.getAccountAddress(),
      data,
      authorityId: opts.authorityId,
    })
  }

  /**
   * Revoke (deactivate) an authority by id via a self-call to `revokeAuthority`,
   * authorised by `authorityId` (a High signer; default the provider's). The
   * contract decrements `passkeyCount` if the target was an active passkey.
   */
  async revokeAuthority(
    targetId: number,
    opts: { authorityId?: number } = {},
  ): Promise<types.TransactionReceipt> {
    const data = ACCOUNT_IFACE.encodeFunctionData('revokeAuthority', [targetId])
    return this.sendTransaction({
      to: await this.getAccountAddress(),
      data,
      authorityId: opts.authorityId,
    })
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async estimateGas(base: types.TransactionRequest): Promise<bigint> {
    try {
      const probe: types.TransactionRequest = {
        ...base,
        customData: {
          ...(base.customData as types.Eip712Meta),
          // 0-authority + empty inner sig: enough for the node to run execution.
          customSignature: abi.encode(['uint256', 'bytes'], [0, '0x']),
        } as types.Eip712Meta,
      }
      const estimate = await this.chainProvider.estimateGas(probe)
      // 20% headroom — AA validation + paymaster add overhead the probe omits.
      return (estimate * 12n) / 10n
    } catch {
      return this.config.defaultGasLimit
    }
  }

  private salt(): string {
    return keccak256(toUtf8Bytes(`cofferdam-native-account|${this.config.userId}`))
  }

  private async publicKey(): Promise<P256PublicKey> {
    if (!this.cachedPublicKey) {
      this.cachedPublicKey = await this.signer.publicKey()
    }
    return this.cachedPublicKey
  }

  /** `abi.encode(qx, qy)` — the passkey authority config blob. */
  private async bootstrapConfig(): Promise<string> {
    return encodePasskeyConfig(await this.publicKey())
  }

  /** `abi.encode(address module, bytes config)` — the CREATE2 constructor input. */
  private async bootstrapInput(): Promise<string> {
    const config = await this.bootstrapConfig()
    return abi.encode(['address', 'bytes'], [this.config.contracts.passkeyModule, config])
  }

  private async aaBytecodeHash(): Promise<string> {
    if (this.cachedBytecodeHash) return this.cachedBytecodeHash
    const factory = new EthContract(this.config.contracts.factory, FACTORY_ABI, this.chainProvider)
    this.cachedBytecodeHash = (await factory.aaBytecodeHash()) as string
    return this.cachedBytecodeHash
  }

  private enforcePolicy(policy: SignInPolicy): void {
    const country = this.config.verifiedClaims.country
    if (policy.allowedCountries && country && !policy.allowedCountries.includes(country)) {
      throw new SignInRejected(
        'country_blocked' as SignInErrorCode,
        `[cofferdam-sdk] native user country '${country}' not in allowedCountries: ${policy.allowedCountries.join(',')}`,
      )
    }
    if (policy.blockedCountries && country && policy.blockedCountries.includes(country)) {
      throw new SignInRejected(
        'country_blocked' as SignInErrorCode,
        `[cofferdam-sdk] native user country '${country}' is in blockedCountries`,
      )
    }
    if (policy.enforceSelfBeforeAccount && !this.config.verified) {
      throw new SignInRejected(
        'self_verification_failed' as SignInErrorCode,
        '[cofferdam-sdk] native user is unverified and policy requires Self before account',
      )
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function encodeSessionToken(payload: object): string {
  // Portable base64url (no `btoa` — unavailable in React Native).
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  return `native.${bytesToBase64url(bytes)}`
}
