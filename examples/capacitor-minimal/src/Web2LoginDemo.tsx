// "Sign in with your existing web2 login -> get a real on-chain account."
//
// This harness shows the Cofferdam LEGACY-AUTH BRIDGE end-to-end: a website
// already running on a plain web2 login (email+password, Google / Apple OAuth,
// or enterprise SSO) maps that credential onto a Base ERC-4337 smart account
// with ZERO wallet UX — no seed phrase, no extension, no gas.
//
// Under the hood (all via the SDK's NativeAccountProvider session lane — see
// packages/core/src/providers/NativeAccountProvider.ts):
//   1. "Log in"  — the consumer's *server* derives a per-account ECDSA session
//                  signer for the authenticated credential; the SDK derives the
//                  account's COUNTERFACTUAL address (no chain write). The web2
//                  login now HAS an on-chain identity.
//   2. "Create"  — CREATE2-deploy the account, bootstrapped with the
//                  SessionKeyAuthority as authority 0 (config = session signer).
//                  Gas paid by the app's paymaster.
//   3a. SSO (LowManaged): "Send gasless tx" — a trusted tier, so it can transact;
//                  the account spends 0 of its own gas.
//   3b. password/OAuth (LowUntrusted): "Upgrade to a passkey" — the one-way
//                  ratchet fires: a High-tier device passkey is enrolled and the
//                  leakable web2 credential is PERMANENTLY locked out. "Try the
//                  old login" then proves it can no longer act.

import { useCallback, useMemo, useState } from 'react'
import { JsonRpcProvider, Wallet as EthersWallet } from 'ethers'
import { NativeAccountProvider, type AuthorityRecord } from '@cofferdam/sdk/native'
import { deriveSessionSigner } from '@cofferdam/sdk'
import type { AuthorityKind, AuthorityState, SignInResponse } from '@cofferdam/sdk'

export type Web2ChainTarget = 'local' | 'testnet'

// ── Login methods -> authority kind + on-chain tier ─────────────────────────

type Method = 'password' | 'google' | 'apple' | 'sso'

interface MethodSpec {
  id: Method
  label: string
  kind: AuthorityKind
  tier: 'low_untrusted' | 'low_managed'
  blurb: string
}

const METHODS: MethodSpec[] = [
  {
    id: 'password',
    label: 'Email + password',
    kind: 'password',
    tier: 'low_untrusted',
    blurb: 'A leakable consumer credential. Confined to enrolling the first passkey, then ratchet-locked.',
  },
  {
    id: 'google',
    label: 'Google OAuth',
    kind: 'oauth_google',
    tier: 'low_untrusted',
    blurb: 'Social login. Same leakable class as a password — upgradeable to a self-custody passkey.',
  },
  {
    id: 'apple',
    label: 'Apple OAuth',
    kind: 'oauth_apple',
    tier: 'low_untrusted',
    blurb: 'Social login. Same leakable class as a password — upgradeable to a self-custody passkey.',
  },
  {
    id: 'sso',
    label: 'Enterprise SSO (Polis)',
    kind: 'polis_sso',
    tier: 'low_managed',
    blurb: 'IdP-brokered, centrally revocable. A trusted tier: can transact and coexists with a later passkey.',
  },
]

// ── Env-driven config ───────────────────────────────────────────────────────

interface Web2Config {
  scope: string
  rpcUrl: string
  chainId: number
  factory: string
  paymaster: string
  passkeyModule: string
  sessionUntrustedModule: string
  sessionManagedModule: string
  adminPrivateKey: string
  label: string
  explorerBase: string | null
  paymasterFundWei: bigint
}

const ANVIL_RICH_WALLET_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

function buildConfig(chain: Web2ChainTarget): Web2Config {
  const env = import.meta.env
  if (chain === 'testnet') {
    return {
      scope: 'capacitor-minimal',
      rpcUrl: (env.VITE_NATIVE_TESTNET_RPC_URL as string | undefined) ?? 'https://sepolia.base.org',
      chainId: Number(env.VITE_NATIVE_TESTNET_CHAIN_ID ?? 84532),
      factory: (env.VITE_NATIVE_TESTNET_FACTORY_ADDRESS as string | undefined) ?? '',
      paymaster: (env.VITE_NATIVE_TESTNET_PAYMASTER_ADDRESS as string | undefined) ?? '',
      passkeyModule: (env.VITE_NATIVE_TESTNET_PASSKEY_MODULE_ADDRESS as string | undefined) ?? '',
      sessionUntrustedModule:
        (env.VITE_NATIVE_TESTNET_SESSION_UNTRUSTED_MODULE_ADDRESS as string | undefined) ?? '',
      sessionManagedModule:
        (env.VITE_NATIVE_TESTNET_SESSION_MANAGED_MODULE_ADDRESS as string | undefined) ?? '',
      adminPrivateKey: (env.VITE_NATIVE_TESTNET_ADMIN_PRIVATE_KEY as string | undefined) ?? '',
      label: 'Base Sepolia',
      explorerBase: 'https://sepolia.basescan.org',
      paymasterFundWei: 2_000_000_000_000_000n, // 0.002 ETH (testnet-frugal)
    }
  }
  return {
    scope: 'capacitor-minimal',
    rpcUrl: (env.VITE_NATIVE_RPC_URL as string | undefined) ?? 'http://127.0.0.1:8545',
    chainId: Number(env.VITE_NATIVE_CHAIN_ID ?? 31337),
    factory: (env.VITE_NATIVE_FACTORY_ADDRESS as string | undefined) ?? '',
    paymaster: (env.VITE_NATIVE_PAYMASTER_ADDRESS as string | undefined) ?? '',
    passkeyModule: (env.VITE_NATIVE_PASSKEY_MODULE_ADDRESS as string | undefined) ?? '',
    sessionUntrustedModule:
      (env.VITE_NATIVE_SESSION_UNTRUSTED_MODULE_ADDRESS as string | undefined) ?? '',
    sessionManagedModule:
      (env.VITE_NATIVE_SESSION_MANAGED_MODULE_ADDRESS as string | undefined) ?? '',
    adminPrivateKey: (env.VITE_NATIVE_ADMIN_PRIVATE_KEY as string | undefined) ?? ANVIL_RICH_WALLET_PK,
    label: 'base-anvil (local)',
    explorerBase: null,
    paymasterFundWei: 100_000_000_000_000_000n, // 0.1 ETH
  }
}

// ── Activity log ────────────────────────────────────────────────────────────

interface LogEntry {
  id: number
  label: string
  status: 'pending' | 'success' | 'error'
  detail?: string
  hash?: string
}
let logSeq = 0

// ── Component ───────────────────────────────────────────────────────────────

interface Web2LoginDemoProps {
  chain: Web2ChainTarget
}

export function Web2LoginDemo({ chain }: Web2LoginDemoProps) {
  const cfg = useMemo(() => buildConfig(chain), [chain])
  const rpc = useMemo(() => new JsonRpcProvider(cfg.rpcUrl), [cfg.rpcUrl])

  const missingAddrs = !cfg.factory || !cfg.paymaster || !cfg.passkeyModule ||
    !cfg.sessionUntrustedModule || !cfg.sessionManagedModule
  const missingAdmin = !cfg.adminPrivateKey
  const configured = !missingAddrs && !missingAdmin

  const [method, setMethod] = useState<Method>('password')
  const [credential, setCredential] = useState('alice@acme.com')

  const [session, setSession] = useState<SignInResponse | null>(null)
  const [authority, setAuthority] = useState<AuthorityState | null>(null)
  const [records, setRecords] = useState<AuthorityRecord[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  const spec = useMemo(() => METHODS.find((m) => m.id === method)!, [method])
  const isManaged = spec.tier === 'low_managed'

  // One provider per (credential, method): a fresh web2 login => its own
  // deterministic on-chain account. The "server" session signer is derived from
  // the authenticated credential; the future upgrade passkey is the provider's
  // default deterministic P-256 signer keyed on the same userId.
  const provider = useMemo(() => {
    if (!configured || !credential.trim()) return null
    const module = isManaged ? cfg.sessionManagedModule : cfg.sessionUntrustedModule
    const userId = `${method}:${credential.trim()}`
    const sessionSigner = deriveSessionSigner(cfg.scope, userId)
    return new NativeAccountProvider({
      scope: cfg.scope,
      rpcUrl: cfg.rpcUrl,
      chainId: cfg.chainId,
      contracts: { factory: cfg.factory, passkeyModule: cfg.passkeyModule, paymaster: cfg.paymaster },
      userId,
      deployerPrivateKey: cfg.adminPrivateKey,
      usePaymaster: true,
      // Realistic per-op gas (verification + call). The 20M default would make
      // handleOps demand ~40M gas, over the testnet block limit (AA95).
      defaultGasLimit: 1_500_000n,
      genesisAuthority: {
        kind: 'session',
        module,
        tier: spec.tier,
        sessionSigner,
        authorityKind: spec.kind,
      },
    })
  }, [configured, credential, method, isManaged, cfg, spec])

  const pushLog = useCallback((label: string): number => {
    const id = ++logSeq
    const entry: LogEntry = { id, label, status: 'pending' }
    setLog((prev) => [entry, ...prev].slice(0, 14))
    return id
  }, [])

  const settleLog = useCallback(
    (id: number, status: 'success' | 'error', detail?: string, hash?: string) => {
      setLog((prev) => prev.map((e) => (e.id === id ? { ...e, status, detail, hash } : e)))
    },
    [],
  )

  const refresh = useCallback(async () => {
    if (!provider) return
    try {
      setAuthority(await provider.getAuthorityState())
    } catch {
      /* ignore */
    }
    try {
      setRecords(await provider.listAuthorities())
    } catch {
      /* ignore */
    }
  }, [provider])

  // Reset session state when the login (provider) changes.
  const resetFor = useCallback(() => {
    setSession(null)
    setAuthority(null)
    setRecords([])
  }, [])

  const login = useCallback(async () => {
    if (!provider) return
    setBusy('login')
    resetFor()
    const id = pushLog(`Log in with ${spec.label} -> derive on-chain account`)
    try {
      const res = await provider.signIn({})
      setSession(res)
      settleLog(id, 'success', res.accountAddress)
      await refresh()
    } catch (err) {
      settleLog(id, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [provider, spec, pushLog, settleLog, refresh, resetFor])

  const create = useCallback(async () => {
    if (!provider) return
    setBusy('create')
    const id = pushLog('Create account on-chain (CREATE2 via factory)')
    try {
      const addr = await provider.ensureDeployed()
      settleLog(id, 'success', `deployed ${addr}`)
      await refresh()
    } catch (err) {
      settleLog(id, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [provider, pushLog, settleLog, refresh])

  const fundPaymaster = useCallback(async () => {
    setBusy('fund')
    const id = pushLog('Fund paymaster (admin -> EntryPoint deposit)')
    try {
      const admin = new EthersWallet(cfg.adminPrivateKey, rpc)
      const tx = await admin.sendTransaction({ to: cfg.paymaster, value: cfg.paymasterFundWei })
      await tx.wait()
      settleLog(id, 'success', 'paymaster funded', tx.hash)
    } catch (err) {
      settleLog(id, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [cfg.adminPrivateKey, cfg.paymaster, cfg.paymasterFundWei, rpc, pushLog, settleLog])

  const gaslessTx = useCallback(async () => {
    if (!provider || !session) return
    setBusy('tx')
    const id = pushLog('Send gasless tx (SSO-signed, account pays 0 gas)')
    try {
      const receipt = await provider.sendTransaction({ to: session.accountAddress, value: 0n })
      settleLog(id, 'success', `status ${receipt.status}`, receipt.hash)
      await refresh()
    } catch (err) {
      settleLog(id, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [provider, session, pushLog, settleLog, refresh])

  const upgrade = useCallback(async () => {
    if (!provider || !session) return
    setBusy('upgrade')
    const id = pushLog('Upgrade to a passkey (enroll High-tier, fire ratchet)')
    try {
      const res = await provider.enrollFirstPasskey({ lane: 'in_browser' })
      settleLog(id, 'success', `passkey ${res.passkeyCredentialId} · web2 login locked out`)
      await refresh()
    } catch (err) {
      settleLog(id, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [provider, session, pushLog, settleLog, refresh])

  const tryLockedTx = useCallback(async () => {
    if (!provider || !session) return
    setBusy('locked')
    const id = pushLog('Try the OLD web2 login again (should be locked out)')
    try {
      await provider.sendTransaction({ to: session.accountAddress, value: 0n })
      settleLog(id, 'error', 'UNEXPECTED: the old login still worked')
    } catch (err) {
      // Expected: the ratchet deactivated the LowUntrusted authority.
      const msg = err instanceof Error ? err.message : String(err)
      settleLog(id, 'success', `locked out as designed (${msg.slice(0, 72)}...)`)
    } finally {
      setBusy(null)
    }
  }, [provider, session, pushLog, settleLog])

  const explorerTx = (hash: string) => (cfg.explorerBase ? `${cfg.explorerBase}/tx/${hash}` : null)
  const upgraded = (authority?.passkeyCount ?? 0) > 0

  return (
    <main className="container container-wide">
      <h1>Cofferdam — Web2 login → on-chain account</h1>
      <p className="lead">
        Map <strong>any login credential</strong> onto a Base ERC-4337 smart account via the{' '}
        <code>SessionKeyAuthority</code> bridge — no seed phrase, no wallet, no gas. Against{' '}
        <strong>{cfg.label}</strong> (chainId {cfg.chainId}).
      </p>

      {!configured && (
        <div className="lead">
          <strong>Not configured.</strong> Deploy with <code>yarn deploy:auth:sepolia</code> and set
          the <code>VITE_NATIVE_TESTNET_*</code> values in <code>.env.local</code>:
          <ul>
            {!cfg.factory && <li>VITE_NATIVE_TESTNET_FACTORY_ADDRESS</li>}
            {!cfg.paymaster && <li>VITE_NATIVE_TESTNET_PAYMASTER_ADDRESS</li>}
            {!cfg.passkeyModule && <li>VITE_NATIVE_TESTNET_PASSKEY_MODULE_ADDRESS</li>}
            {!cfg.sessionUntrustedModule && <li>VITE_NATIVE_TESTNET_SESSION_UNTRUSTED_MODULE_ADDRESS</li>}
            {!cfg.sessionManagedModule && <li>VITE_NATIVE_TESTNET_SESSION_MANAGED_MODULE_ADDRESS</li>}
            {!cfg.adminPrivateKey && <li>VITE_NATIVE_TESTNET_ADMIN_PRIVATE_KEY</li>}
          </ul>
        </div>
      )}

      {/* Pick a web2 login method */}
      <div className="funder-picker">
        <span className="funder-label">Your existing login method</span>
        <div className="funder-candidates">
          {METHODS.map((m) => (
            <button
              key={m.id}
              className={`funder-chip ${method === m.id ? 'funder-chip-on' : ''}`}
              onClick={() => {
                setMethod(m.id)
                resetFor()
              }}
              disabled={busy !== null}
              title={m.blurb}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="profile">
          Maps to authority <code>{spec.kind}</code> · tier <code>{spec.tier}</code>. {spec.blurb}
        </p>
        <label className="funder-label" htmlFor="cred">
          Credential the server authenticated (email / subject)
        </label>
        <input
          id="cred"
          className="cred-input"
          value={credential}
          onChange={(e) => {
            setCredential(e.target.value)
            resetFor()
          }}
          placeholder="alice@acme.com"
          disabled={busy !== null}
        />
      </div>

      {/* Lifecycle */}
      <div className="actions">
        <button onClick={login} disabled={!provider || busy !== null}>
          {busy === 'login' ? '…' : '1. Log in'}
        </button>
        <button onClick={create} disabled={!session || busy !== null}>
          {busy === 'create' ? '…' : '2. Create account'}
        </button>
        <button onClick={fundPaymaster} disabled={!configured || busy !== null}>
          {busy === 'fund' ? '…' : 'Fund paymaster'}
        </button>
        {isManaged ? (
          <button className="action-settle" onClick={gaslessTx} disabled={!session || busy !== null}>
            {busy === 'tx' ? '…' : '3. Send gasless tx'}
          </button>
        ) : (
          <button className="action-settle" onClick={upgrade} disabled={!session || busy !== null || upgraded}>
            {busy === 'upgrade' ? '…' : '3. Upgrade to a passkey'}
          </button>
        )}
        {!isManaged && upgraded && (
          <button className="action-cancel" onClick={tryLockedTx} disabled={busy !== null}>
            {busy === 'locked' ? '…' : '4. Try the old login (locked out)'}
          </button>
        )}
      </div>

      {session && (
        <pre className="session">
          {JSON.stringify(
            {
              login: `${method}:${credential.trim()}`,
              accountAddress: session.accountAddress,
              appPseudonym: session.appPseudonym,
              authority: session.authority,
              accountDeployed: authority?.accountDeployed ?? session.accountDeployed,
              passkeyCount: authority?.passkeyCount,
              upgradeLocked: authority?.upgradeLocked,
              migrationStatus: authority?.migrationStatus ?? session.migrationStatus,
            },
            null,
            2,
          )}
        </pre>
      )}

      {records.length > 0 && (
        <div className="funder-picker">
          <span className="funder-label">On-chain authority registry</span>
          <ul className="activity">
            {records.map((r) => (
              <li key={r.id} className={`activity-row ${r.active ? 'activity-success' : 'activity-error'}`}>
                <span className="activity-status">{r.active ? '●' : '○'}</span>
                <span className="activity-label">
                  #{r.id} {r.kind} ({r.tier}){r.active ? '' : ' — revoked / locked out'}
                </span>
                <code className="activity-hash">{r.module.slice(0, 10)}…</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {log.length > 0 && (
        <ul className="activity">
          {log.map((e) => (
            <li key={e.id} className={`activity-row activity-${e.status}`}>
              <span className="activity-status">
                {e.status === 'pending' ? '⏳' : e.status === 'success' ? '✓' : '✗'}
              </span>
              <span className="activity-label">{e.label}</span>
              {e.detail && <code className="activity-hash">{e.detail}</code>}
              {e.hash &&
                (explorerTx(e.hash) ? (
                  <a className="activity-hash" href={explorerTx(e.hash)!} target="_blank" rel="noreferrer">
                    {e.hash.slice(0, 14)}…
                  </a>
                ) : (
                  <code className="activity-hash">{e.hash.slice(0, 14)}…</code>
                ))}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
