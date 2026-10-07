// NativeAccountProvider — ERC-4337 Account Abstraction provider for Base.
//
// The production-shaped sibling of `LocalChainProvider`. Where LocalChainProvider
// returns a plain EOA, this provider bridges the SDK to the ERC-4337 contract
// stack (base-contracts/contracts/account):
//
//   - CofferdamAccountFactory4337 — CREATE2 factory for CofferdamAccount4337.
//   - CofferdamAccount4337        — the ERC-4337 `IAccount` wallet, governed by a
//                                   High-tier P-256 passkey authority.
//   - CofferdamPaymaster          — dev/test gas sponsor (production: CDP Paymaster).
//   - PasskeyAuthority            — stateless High-tier P-256 module that verifies
//                                   raw 64-byte `r || s` signatures. Used with
//                                   `DeterministicPasskeySigner` (not WebAuthn).
//   - EntryPoint v0.7             — preinstalled at
//     0x0000000071727De22E5E9d8BAf0edAc6f37da032 on Base.
//
// What `signIn()` does:
//   1. Get the user's P-256 passkey public key (via a pluggable `PasskeySigner`;
//      default is a deterministic software key for PoC).
//   2. Build the account's bootstrap `config = abi.encode(qx, qy)` and a stable
//      CREATE2 `salt` from the user id.
//   3. Derive the COUNTERFACTUAL account address by calling the factory's
//      `getAddress` view, so the wallet has an address before it is deployed.
//   4. Optionally deploy the account now (PoC: via `deployerPrivateKey`).
//
// `sendTransaction()` builds an ERC-4337 PackedUserOperation, signs the
// userOpHash with the passkey, and submits via `EntryPoint.handleOps()`.
//
// Signature format: `solidityPacked(uint256 authorityId, bytes innerSignature)`
// where `innerSignature` is the raw 64-byte P-256 `r || s` from the passkey
// signer. The account's `_authenticate` dispatches to `PasskeyAuthority`
// which verifies the raw P-256 signature against the stored public key.
//
// Gas sponsorship:
//   - Production: CDP Paymaster (ERC-7677 hosted service, not deployable locally).
//     The `paymasterAndData` field is populated server-side via `pm_getPaymasterData`.
//   - Local dev (simple calls): `CofferdamPaymaster` stub — `paymasterAndData` is
//     `solidityPacked(address, uint128 verificationGasLimit, uint128 postOpGasLimit)`.
//   - Local dev (authority management): pre-fund the account with ETH and set
//     `usePaymaster: false`. The account pays gas via its own EntryPoint deposit.
//
// Authority management (addBackupPasskey / revokeAuthority):
//   These are self-calls: the UserOp's `callData` encodes
//   `account.execute(accountAddress, 0, addAuthorityCalldata)`.
//   The contract's `addAuthority`/`revokeAuthority` accept `msg.sender` being
//   either the EntryPoint or the account itself (self-call via `execute`).
//
// Nonce handling:
//   `ensureDeployed()` and `sendTransaction()` each create a fresh
//   `JsonRpcProvider` + `EthWallet` for the deployer/bundler. This avoids
//   ethers v6's per-provider nonce cache returning stale values when the
//   same private key is reused across multiple wallet instances.

import {
  AbiCoder,
  getBytes,
  keccak256,
  toUtf8Bytes,
  solidityPacked,
  Contract as EthContract,
  JsonRpcProvider,
  Wallet as EthWallet,
  Interface,
  type TransactionReceipt,
} from 'ethers'

import { derivePseudonym, deriveScopeKey } from '../identity/pseudonym.js'
import {
  DeterministicPasskeySigner,
  encodePasskeyConfig,
  type PasskeySigner,
  type P256PublicKey,
} from '../identity/passkey.js'
import {
  encodeSessionConfig,
  signSessionInner,
  type SessionSigner,
} from '../identity/sessionKey.js'
import { bytesToBase64url } from '../identity/webauthn.js'
import { signSessionAttestation } from '../identity/sessionAttestation.js'
import { SignInRejected } from './MockProvider.js'
import type {
  AuthorityDescriptor,
  AuthorityKind,
  AuthorityState,
  AuthorityTier,
  CofferdamProvider,
  DeviceCapability,
  EnrollFirstPasskeyOptions,
  MigrationStatus,
  NetworkMode,
  PasskeyEnrollmentResult,
  SignInErrorCode,
  SignInPolicy,
  SignInResponse,
  VerifiedClaims,
} from '../types.js'

export { SignInRejected } from './MockProvider.js'

const abi = AbiCoder.defaultAbiCoder()

/** Canonical ERC-4337 EntryPoint v0.7 address on Base. */
const ENTRY_POINT_ADDRESS = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

/** Minimal factory ABI — only the surface this provider calls. */
const FACTORY_ABI = [
  'function getAddress(address initialModule, bytes initialConfig, bytes32 salt) view returns (address)',
  'function deployAccount(address initialModule, bytes initialConfig, bytes32 salt) returns (address)',
] as const

/** Minimal account ABI for on-chain authority reads + management self-calls. */
const ACCOUNT_ABI = [
  'function passkeyCount() view returns (uint256)',
  'function upgradeLocked() view returns (bool)',
  'function authorityCount() view returns (uint256)',
  'function getAuthority(uint256 authorityId) view returns (address module, uint8 tier, bool active, bytes config)',
  'function addAuthority(uint256 authorityId, address newModule, bytes newConfig) returns (uint256 newAuthorityId)',
  'function revokeAuthority(uint256 authorityId, uint256 targetId)',
  'function enrollFirstPasskey(uint256 lowAuthorityId, address passkeyModule, bytes passkeyConfig)',
  'function execute(address target, uint256 value, bytes data) external',
] as const

/** Encoder for the account execute calldata (addAuthority / revokeAuthority / execute). */
const ACCOUNT_IFACE = new Interface(ACCOUNT_ABI as unknown as string[])

/** Minimal EntryPoint ABI — only the surface this provider calls. */
const ENTRY_POINT_ABI = [
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary)',
  'function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)',
  'function getNonce(address sender, uint192 key) view returns (uint256 nonce)',
  'function balanceOf(address account) view returns (uint256)',
  'function depositTo(address account) payable',
] as const

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

export type { SessionSigner } from '../identity/sessionKey.js'

/**
 * Genesis (authority 0) lane for the account. Defaults to the High-tier passkey
 * (sovereign-first onboarding). Set `{ kind: 'session', ... }` to bootstrap the
 * account from a web2 login via a server-held session signer — the legacy-auth
 * bridge (`SessionKeyAuthority`). This is what maps "any login credential" to an
 * on-chain account.
 */
export type GenesisAuthorityConfig =
  | { kind: 'passkey' }
  | {
      /** Bootstrap from a web2 login via a server session signer. */
      kind: 'session'
      /** `SessionKeyAuthority` module address (deployed at `tier`). */
      module: string
      /**
       * Tier the module was deployed at. `low_untrusted` (password / OAuth) is
       * confined to first-passkey enrolment and locked out by the ratchet;
       * `low_managed` (Polis SSO) coexists with a later passkey.
       */
      tier: 'low_untrusted' | 'low_managed'
      /** Server-held session signer (an ethers `Wallet` works). */
      sessionSigner: SessionSigner
      /** Optional UI label; defaults from `tier` (password / polis_sso). */
      authorityKind?: AuthorityKind
    }

export interface NativeAccountProviderConfig {
  /** Consumer-app identifier (e.g. 'offshoresync'). */
  scope: string
  /** Per-scope salt for pseudonym derivation. Defaults to a value from `scope`. */
  scopeSalt?: string

  /** RPC URL of the Base node. Local default: 'http://127.0.0.1:8545' (base-anvil). */
  rpcUrl: string
  /** Chain id. base-anvil = 31337; Base Sepolia = 84532; Base mainnet = 8453. */
  chainId: number

  contracts: {
    /** `CofferdamAccountFactory4337` address. */
    factory: string
    /** `WebAuthnPasskeyAuthority` (High-tier) module address. */
    passkeyModule: string
    /** `CofferdamPaymaster` address. Required for sponsored (gasless) txs.
     *  Production: use CDP Paymaster via paymasterService capability instead. */
    paymaster?: string
    /**
     * Override the canonical ERC-4337 EntryPoint address. Defaults to
     * 0x0000000071727De22E5E9d8BAf0edAc6f37da032 (preinstalled on Base).
     * Override only for testing on non-Base chains.
     */
    entryPoint?: string
  }

  /** Stable per-user id → deterministic CREATE2 salt (and PoC passkey). */
  userId?: string

  /**
   * Pluggable passkey signer. Defaults to a deterministic software signer keyed
   * on `userId` (PoC). Swap for a hardware/WebAuthn signer in production. In the
   * session-genesis lane this is the FUTURE upgrade passkey (used by
   * `enrollFirstPasskey`).
   */
  signer?: PasskeySigner

  /**
   * Genesis authority lane. Omit (or `{ kind: 'passkey' }`) for the High-tier
   * passkey default; set `{ kind: 'session', ... }` to map a web2 login onto the
   * account via the `SessionKeyAuthority` legacy-auth bridge.
   */
  genesisAuthority?: GenesisAuthorityConfig

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
    entryPoint: string
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
  genesis: GenesisAuthorityConfig
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
  private readonly chainProvider: JsonRpcProvider
  private readonly signer: PasskeySigner

  private cachedPublicKey: P256PublicKey | null = null
  private cachedAddress: string | null = null
  private cachedSessionSignerAddress: string | null = null

  constructor(config: NativeAccountProviderConfig) {
    const genesis: GenesisAuthorityConfig = config.genesisAuthority ?? { kind: 'passkey' }
    if (genesis.kind === 'session' && !genesis.module) {
      throw new Error(
        '[cofferdam-sdk] NativeAccountProvider: genesisAuthority.kind="session" requires a SessionKeyAuthority `module` address.',
      )
    }
    this.config = {
      scope: config.scope,
      scopeSalt: config.scopeSalt ?? `native-salt:${config.scope}`,
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      contracts: {
        factory: config.contracts.factory,
        passkeyModule: config.contracts.passkeyModule,
        paymaster: config.contracts.paymaster,
        entryPoint: config.contracts.entryPoint ?? ENTRY_POINT_ADDRESS,
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
      genesis,
    }
    // chainId 31337 = local base-anvil; 84532 = Base Sepolia; 8453 = Base mainnet.
    this.mode = this.config.chainId === 84532 || this.config.chainId === 8453 ? 'testnet' : 'local'
    this.chainProvider = new JsonRpcProvider(this.config.rpcUrl)
    this.signer = config.signer ?? new DeterministicPasskeySigner(this.config.userId)
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
    const fields = {
      scope: this.config.scope,
      appPseudonym,
      accountAddress,
      chainId: this.config.chainId,
      verified: this.config.verified,
      issuedAt,
    }
    // The attestation binds the security-relevant response fields to the genesis
    // authority: a P-256 passkey envelope (verify with
    // `decodeAndVerifySessionAttestation`) for the passkey lane, or a
    // session-signer ECDSA envelope for the web2-credential lane.
    const attestation =
      this.config.genesis.kind === 'session'
        ? await this.signSessionModeAttestation(fields)
        : await signSessionAttestation({
            signer: this.signer,
            publicKey: await this.publicKey(),
            fields,
          })

    const migrationStatus: MigrationStatus =
      this.config.genesis.kind === 'session' ? 'pending' : 'enrolled'

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
      authority: this.genesisDescriptor(),
      migrationStatus,
      accountDeployed: deployed,
    }
  }

  signOut(): void {
    // No persistent state beyond the cached derivations; chain state is on-chain.
  }

  async getAuthorityState(): Promise<AuthorityState> {
    const accountAddress = await this.getAccountAddress()
    const deployed = await this.isDeployed()
    const isSession = this.config.genesis.kind === 'session'

    if (deployed) {
      const account = new EthContract(accountAddress, ACCOUNT_ABI as unknown as string[], this.chainProvider)
      const [passkeyCount, upgradeLocked] = await Promise.all([
        account.passkeyCount() as Promise<bigint>,
        account.upgradeLocked() as Promise<boolean>,
      ])
      return {
        active: this.genesisDescriptor(),
        passkeyCount: Number(passkeyCount),
        upgradeLocked,
        accountDeployed: true,
        migrationStatus: isSession ? (Number(passkeyCount) > 0 ? 'enrolled' : 'pending') : 'enrolled',
      }
    }

    // Counterfactual. Passkey genesis: the bootstrap config holds exactly one
    // passkey and the ratchet is conceptually locked. Session genesis: a web2
    // credential governs the account, no passkey yet, ratchet open (upgradable).
    if (isSession) {
      return {
        active: this.genesisDescriptor(),
        passkeyCount: 0,
        upgradeLocked: false,
        accountDeployed: false,
        migrationStatus: 'pending',
      }
    }
    return {
      active: this.genesisDescriptor(),
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
    const factory = new EthContract(this.config.contracts.factory, FACTORY_ABI as unknown as string[], this.chainProvider)
    const config = await this.bootstrapConfig()
    this.cachedAddress = (await factory.getFunction('getAddress')(
      this.genesisModule(),
      config,
      this.salt(),
    )) as string
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
    const deployer = new EthWallet(this.config.deployerPrivateKey, new JsonRpcProvider(this.config.rpcUrl))
    const factory = new EthContract(this.config.contracts.factory, FACTORY_ABI as unknown as string[], deployer)
    const config = await this.bootstrapConfig()
    const tx = await factory.getFunction('deployAccount')(this.genesisModule(), config, this.salt())
    await tx.wait()
    return addr
  }

  // ── Transactions ───────────────────────────────────────────────────────────

  /**
   * Submit an ERC-4337 UserOperation from the smart account, signed by the
   * passkey authority and, by default, sponsored by the paymaster. The UserOp's
   * callData encodes `account.execute(target, value, data)`, which the EntryPoint
   * calls after `validateUserOp` succeeds. Auto-deploys the account first if a
   * deployer key is configured.
   */
  async sendTransaction(req: NativeTxRequest): Promise<TransactionReceipt> {
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

    const entryPoint = new EthContract(this.config.contracts.entryPoint, ENTRY_POINT_ABI as unknown as string[], this.chainProvider)

    // ── Build the callData: account.execute(target, value, data) ───────────
    const executeData = ACCOUNT_IFACE.encodeFunctionData('execute', [
      req.to,
      req.value ?? 0n,
      req.data ?? '0x',
    ])

    // ── Get the account nonce from the EntryPoint ─────────────────────────
    const nonce = await (entryPoint.getNonce(accountAddress, 0n) as Promise<bigint>)

    // ── Pack gas fields for ERC-4337 v0.7 ─────────────────────────────────
    const feeData = await this.chainProvider.getFeeData()
    const gasPrice = feeData.gasPrice ?? 1_000_000_000n
    const verificationGasLimit = req.gasLimit ?? this.config.defaultGasLimit
    const callGasLimit = req.gasLimit ?? this.config.defaultGasLimit
    const accountGasLimits = packGasLimits(verificationGasLimit, callGasLimit)
    const gasFees = packGasFees(gasPrice, gasPrice) // priority = base for simplicity

    // ── Build the PackedUserOperation ─────────────────────────────────────
    const userOp = {
      sender: accountAddress,
      nonce,
      initCode: '0x', // account already deployed (ensured above)
      callData: executeData,
      accountGasLimits,
      preVerificationGas: 0n,
      gasFees,
      paymasterAndData:
        usePaymaster && paymaster
          ? solidityPacked(
              ['address', 'uint128', 'uint128'],
              [paymaster, verificationGasLimit, 100_000n],
            )
          : '0x',
      signature: '0x', // placeholder — set after hashing
    }

    // ── Get the userOpHash from the EntryPoint ────────────────────────────
    const userOpHash = await (entryPoint.getUserOpHash(userOp) as Promise<string>)

    // ── Sign the hash with the genesis authority (prefixed with authorityId) ──
    const authorityId = req.authorityId ?? this.config.authorityId
    const innerSignature = await this.signInner(accountAddress, userOpHash)
    const signature = solidityPacked(['uint256', 'bytes'], [authorityId, innerSignature])

    // ── Set the signature and submit via handleOps ────────────────────────
    const finalUserOp = { ...userOp, signature }

    // The deployer (or any funded EOA) submits the bundle to the EntryPoint.
    // In production, a bundler service handles this; for PoC the deployer key
    // doubles as the bundler.
    // Create a fresh provider+wallet for the bundler to avoid stale nonce
    // caching when ensureDeployed used the same key via the shared provider.
    const bundlerProvider = new JsonRpcProvider(this.config.rpcUrl)
    const bundler = this.config.deployerPrivateKey
      ? new EthWallet(this.config.deployerPrivateKey, bundlerProvider)
      : null
    if (!bundler) {
      throw new Error(
        '[cofferdam-sdk] sendTransaction: no deployerPrivateKey configured. ' +
          'A funded signer is needed to submit the UserOp bundle to the EntryPoint.',
      )
    }

    const entryPointWithSigner = new EthContract(
      this.config.contracts.entryPoint,
      ENTRY_POINT_ABI as unknown as string[],
      bundler,
    )
    const tx = await entryPointWithSigner.handleOps([finalUserOp], bundler.getAddress())
    return tx.wait() as Promise<TransactionReceipt>
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
      const desc = this.genesisDescriptor()
      const isPasskey = this.config.genesis.kind !== 'session'
      return [
        {
          id: 0,
          module: this.genesisModule(),
          tier: desc.tier,
          kind: desc.kind,
          active: true,
          isPasskey,
          isSelf: true,
          config: ownConfig,
        },
      ]
    }

    const account = new EthContract(await this.getAccountAddress(), ACCOUNT_ABI as unknown as string[], this.chainProvider)
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
        isSelf: config.toLowerCase() === ownConfig,
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
  ): Promise<TransactionReceipt> {
    const state = await this.getAuthorityState()
    if (state.passkeyCount >= MAX_PASSKEYS) throw new PasskeyCapReachedError()

    const data = ACCOUNT_IFACE.encodeFunctionData('addAuthority', [
      opts.authorityId ?? this.config.authorityId,
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
  ): Promise<TransactionReceipt> {
    const data = ACCOUNT_IFACE.encodeFunctionData('revokeAuthority', [
      opts.authorityId ?? this.config.authorityId,
      targetId,
    ])
    return this.sendTransaction({
      to: await this.getAccountAddress(),
      data,
      authorityId: opts.authorityId,
    })
  }

  /**
   * Enrol the FIRST device passkey from a web2-credential (session) account and
   * FIRE THE ONE-WAY RATCHET: the account gains a High-tier passkey and every
   * LowUntrusted authority (the original web2 login) is permanently deactivated
   * (IDENTITY_LAYER_DESIGN.md §2.5.2). This is the single action a LowUntrusted
   * authority may perform. The new passkey is this provider's `signer` (the PoC
   * deterministic passkey by default; pass a hardware/WebAuthn signer in prod).
   *
   * Only valid in the session lane; the passkey lane is already High-tier.
   */
  async enrollFirstPasskey(
    _opts: EnrollFirstPasskeyOptions = { lane: 'in_browser' },
  ): Promise<PasskeyEnrollmentResult> {
    if (this.config.genesis.kind !== 'session') {
      throw new Error(
        '[cofferdam-sdk] enrollFirstPasskey: account was bootstrapped from a passkey ' +
          '(already High-tier). This upgrade path is for web2-credential (session) accounts.',
      )
    }
    await this.ensureDeployed()
    const pub = await this.publicKey()
    const lowAuthorityId = this.config.authorityId // session genesis lives at id 0
    const data = ACCOUNT_IFACE.encodeFunctionData('enrollFirstPasskey', [
      lowAuthorityId,
      this.config.contracts.passkeyModule,
      encodePasskeyConfig(pub),
    ])
    await this.sendTransaction({
      to: await this.getAccountAddress(),
      data,
      authorityId: lowAuthorityId,
    })
    return {
      accountAddress: await this.getAccountAddress(),
      accountDeployed: true,
      passkeyCredentialId: `p256:${pub.qx.slice(2, 18)}`,
      authority: { kind: 'passkey', tier: 'high' },
      migrationStatus: 'enrolled',
      upgradeLocked: true,
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Estimate gas for an ERC-4337 UserOp by eth_estimateGas on the execute call.
   * This is a rough approximation — production should use a bundler's
   * `eth_estimateUserOperationGas` RPC method.
   */
  private async estimateGas(accountAddress: string, req: NativeTxRequest): Promise<bigint> {
    try {
      const data = ACCOUNT_IFACE.encodeFunctionData('execute', [
        req.to,
        req.value ?? 0n,
        req.data ?? '0x',
      ])
      const estimate = await this.chainProvider.estimateGas({
        from: this.config.contracts.entryPoint,
        to: accountAddress,
        data,
      })
      // 30% headroom — ERC-4337 validation + paymaster overhead.
      return (estimate * 13n) / 10n
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

  /** Genesis authority module address (passkey module or session module). */
  private genesisModule(): string {
    return this.config.genesis.kind === 'session'
      ? this.config.genesis.module
      : this.config.contracts.passkeyModule
  }

  /** Resolve (and cache) the server session-signer address. */
  private async sessionSignerAddress(): Promise<string> {
    if (this.config.genesis.kind !== 'session') {
      throw new Error('[cofferdam-sdk] sessionSignerAddress called outside the session lane.')
    }
    if (!this.cachedSessionSignerAddress) {
      this.cachedSessionSignerAddress = await this.config.genesis.sessionSigner.getAddress()
    }
    return this.cachedSessionSignerAddress
  }

  /**
   * Genesis authority config blob: `abi.encode(qx, qy)` for the passkey lane, or
   * `abi.encode(sessionSigner)` for the web2-credential (session) lane.
   */
  private async bootstrapConfig(): Promise<string> {
    if (this.config.genesis.kind === 'session') {
      return encodeSessionConfig(await this.sessionSignerAddress())
    }
    return encodePasskeyConfig(await this.publicKey())
  }

  /** The descriptor for the configured genesis authority. */
  private genesisDescriptor(): AuthorityDescriptor {
    if (this.config.genesis.kind === 'session') {
      const tier = this.config.genesis.tier
      const kind = this.config.genesis.authorityKind ?? (tier === 'low_managed' ? 'polis_sso' : 'password')
      return { kind, tier }
    }
    return { kind: 'passkey', tier: 'high' }
  }

  /** Sign an account digest with the genesis authority's inner signature. */
  private async signInner(account: string, digest: string): Promise<string> {
    if (this.config.genesis.kind === 'session') {
      return signSessionInner(this.config.genesis.sessionSigner, account, digest)
    }
    return this.signer.sign(getBytes(digest))
  }

  /**
   * Session-lane attestation: an ECDSA envelope signed by the server session
   * signer over the security-relevant sign-in fields. Honest about its origin
   * (the legacy-auth bridge vouched), distinct from the P-256 `csa1:` passkey
   * attestation. Format: `csa-sess1.<base64url(json)>.<0x sig>`.
   */
  private async signSessionModeAttestation(fields: object): Promise<string> {
    if (this.config.genesis.kind !== 'session') {
      throw new Error('[cofferdam-sdk] signSessionModeAttestation called outside the session lane.')
    }
    const bytes = new TextEncoder().encode(JSON.stringify(fields))
    const digest = keccak256(bytes)
    const sig = await this.config.genesis.sessionSigner.signMessage(getBytes(digest))
    return `csa-sess1.${bytesToBase64url(bytes)}.${sig}`
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

/**
 * Pack two uint128 gas values into a single bytes32 for ERC-4337 v0.7.
 * High 128 bits = verificationGasLimit, low 128 bits = callGasLimit.
 */
function packGasLimits(verificationGasLimit: bigint, callGasLimit: bigint): string {
  const mask = (1n << 128n) - 1n
  const packed = (verificationGasLimit & mask) << 128n | (callGasLimit & mask)
  return '0x' + packed.toString(16).padStart(64, '0')
}

/**
 * Pack maxPriorityFeePerGas and maxFeePerGas into a bytes32 for ERC-4337 v0.7.
 * High 128 bits = maxPriorityFeePerGas, low 128 bits = maxFeePerGas.
 */
function packGasFees(maxPriorityFeePerGas: bigint, maxFeePerGas: bigint): string {
  const mask = (1n << 128n) - 1n
  const packed = (maxPriorityFeePerGas & mask) << 128n | (maxFeePerGas & mask)
  return '0x' + packed.toString(16).padStart(64, '0')
}
