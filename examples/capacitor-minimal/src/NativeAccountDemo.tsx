// Interactive harness for the native Base Account Abstraction stack,
// driven by the SDK's `NativeAccountProvider`. This is the production-shaped
// sibling of LocalChainDemo: instead of a plain EOA, sign-in yields a
// passkey-governed CofferdamSmartAccount, derived counterfactually (no chain
// write) from a P-256 key.
//
// The flow shown:
//   1. Sign in           — derive the High-tier P-256 passkey + the account's
//                          COUNTERFACTUAL address (off-chain, matches the
//                          on-chain CofferdamAccountFactory).
//   2. Deploy account    — CREATE2-deploy the smart account via the factory
//                          (one-time; the address never changes).
//   3. Sponsored tx      — send an ERC-4337 UserOp signed by the passkey
//                          and paid for by the CofferdamPaymaster, so the
//                          account spends ZERO of its own ETH.
//
// Two networks via the `chain` prop:
//   - chain="local"   : base-anvil (forked Base). Reads VITE_NATIVE_* env; the
//                       admin key defaults to anvil's public rich wallet #0
//                       and is used to deploy the account + fund the paymaster.
//   - chain="testnet" : Base Sepolia (chainId 84532). VITE_NATIVE_* env;
//                       admin key has NO default and must hold ETH.

import { useCallback, useMemo, useState } from 'react'
import { JsonRpcProvider, Wallet as EthersWallet } from 'ethers'
import { NativeAccountProvider } from '@cofferdam/sdk/native'
import type { AuthorityState, SignInResponse } from '@cofferdam/sdk'

// ────────────────────────────────────────────────────────────────────────────
// Env-driven config
// ────────────────────────────────────────────────────────────────────────────

export type NativeChainTarget = 'local' | 'testnet'

interface NativeConfig {
  rpcUrl: string
  chainId: number
  factory: string
  paymaster: string
  passkeyModule: string
  adminPrivateKey: string
  userId: string
  label: string
  explorerBase: string | null
}

// Anvil's public rich-wallet #0 — fully public, fine for local dev only.
const ANVIL_RICH_WALLET_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

function buildNativeConfig(chain: NativeChainTarget): NativeConfig {
  const env = import.meta.env
  if (chain === 'testnet') {
    return {
      rpcUrl: (env.VITE_NATIVE_TESTNET_RPC_URL as string | undefined) ?? 'https://sepolia.base.org',
      chainId: Number(env.VITE_NATIVE_TESTNET_CHAIN_ID ?? 84532),
      factory: (env.VITE_NATIVE_TESTNET_FACTORY_ADDRESS as string | undefined) ?? '',
      paymaster: (env.VITE_NATIVE_TESTNET_PAYMASTER_ADDRESS as string | undefined) ?? '',
      passkeyModule: (env.VITE_NATIVE_TESTNET_PASSKEY_MODULE_ADDRESS as string | undefined) ?? '',
      adminPrivateKey: (env.VITE_NATIVE_TESTNET_ADMIN_PRIVATE_KEY as string | undefined) ?? '',
      userId: (env.VITE_NATIVE_USER_ID as string | undefined) ?? 'sepolia-native-1',
      label: 'Base Sepolia',
      explorerBase: 'https://sepolia.basescan.org',
    }
  }
  return {
    rpcUrl: (env.VITE_NATIVE_RPC_URL as string | undefined) ?? 'http://127.0.0.1:8545',
    chainId: Number(env.VITE_NATIVE_CHAIN_ID ?? 31337),
    factory: (env.VITE_NATIVE_FACTORY_ADDRESS as string | undefined) ?? '',
    paymaster: (env.VITE_NATIVE_PAYMASTER_ADDRESS as string | undefined) ?? '',
    passkeyModule: (env.VITE_NATIVE_PASSKEY_MODULE_ADDRESS as string | undefined) ?? '',
    adminPrivateKey:
      (env.VITE_NATIVE_ADMIN_PRIVATE_KEY as string | undefined) ?? ANVIL_RICH_WALLET_PK,
    userId: (env.VITE_NATIVE_USER_ID as string | undefined) ?? 'local-native-1',
    label: 'base-anvil (local)',
    explorerBase: null,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Activity log
// ────────────────────────────────────────────────────────────────────────────

interface LogEntry {
  id: number
  label: string
  status: 'pending' | 'success' | 'error'
  detail?: string
  hash?: string
}

let logSeq = 0

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

interface NativeAccountDemoProps {
  chain: NativeChainTarget
}

export function NativeAccountDemo({ chain }: NativeAccountDemoProps) {
  const cfg = useMemo(() => buildNativeConfig(chain), [chain])
  const rpc = useMemo(() => new JsonRpcProvider(cfg.rpcUrl), [cfg.rpcUrl])

  const missingAddrs = !cfg.factory || !cfg.paymaster || !cfg.passkeyModule
  const missingAdmin = !cfg.adminPrivateKey
  const configured = !missingAddrs && !missingAdmin

  const provider = useMemo(() => {
    if (!configured) return null
    return new NativeAccountProvider({
      scope: 'capacitor-minimal',
      rpcUrl: cfg.rpcUrl,
      chainId: cfg.chainId,
      contracts: {
        factory: cfg.factory,
        paymaster: cfg.paymaster,
        passkeyModule: cfg.passkeyModule,
      },
      userId: cfg.userId,
      deployerPrivateKey: cfg.adminPrivateKey,
      usePaymaster: true,
      defaultGasLimit: 1_500_000n,
    })
  }, [cfg, configured])

  const [session, setSession] = useState<SignInResponse | null>(null)
  const [authority, setAuthority] = useState<AuthorityState | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  const pushLog = useCallback((label: string): number => {
    const id = ++logSeq
    const entry: LogEntry = { id, label, status: 'pending' }
    setLog((prev) => [entry, ...prev].slice(0, 12))
    return id
  }, [])

  const settleLog = useCallback(
    (id: number, status: 'success' | 'error', detail?: string, hash?: string) => {
      setLog((prev) => prev.map((e) => (e.id === id ? { ...e, status, detail, hash } : e)))
    },
    [],
  )

  const refresh = useCallback(
    async (addr: string) => {
      try {
        setBalance(await rpc.getBalance(addr))
      } catch {
        /* node unreachable */
      }
      if (provider) {
        try {
          setAuthority(await provider.getAuthorityState())
        } catch {
          /* ignore */
        }
      }
    },
    [rpc, provider],
  )

  const signIn = useCallback(async () => {
    if (!provider) return
    setBusy('signin')
    const id = pushLog('Sign in (derive passkey + counterfactual address)')
    try {
      const res = await provider.signIn({})
      setSession(res)
      settleLog(id, 'success', res.accountAddress)
      await refresh(res.accountAddress)
    } catch (err) {
      settleLog(id, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [provider, pushLog, settleLog, refresh])

  const deploy = useCallback(async () => {
    if (!provider || !session) return
    setBusy('deploy')
    const id = pushLog('Deploy CofferdamSmartAccount (CREATE2)')
    try {
      const addr = await provider.ensureDeployed()
      settleLog(id, 'success', `deployed ${addr}`)
      await refresh(addr)
    } catch (err) {
      settleLog(id, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [provider, session, pushLog, settleLog, refresh])

  const fundPaymaster = useCallback(async () => {
    if (!provider) return
    setBusy('fund')
    const id = pushLog('Fund paymaster (admin → CofferdamPaymaster)')
    try {
      const admin = new EthersWallet(cfg.adminPrivateKey, rpc)
      const tx = await admin.sendTransaction({ to: cfg.paymaster, value: 100_000_000_000_000_000n }) // 0.1 ETH
      await tx.wait()
      const bal = await rpc.getBalance(cfg.paymaster)
      settleLog(id, 'success', `paymaster balance ${bal} wei`, tx.hash)
    } catch (err) {
      settleLog(id, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [provider, cfg.adminPrivateKey, cfg.paymaster, rpc, pushLog, settleLog])

  const sendSponsored = useCallback(async () => {
    if (!provider || !session) return
    setBusy('send')
    const id = pushLog('Send paymaster-sponsored tx (account pays 0 gas)')
    try {
      // No-op self-call: exercises validate → paymaster pay → execute without
      // moving value. The whole gas cost is borne by the paymaster.
      const receipt = await provider.sendTransaction({
        to: session.accountAddress,
        value: 0n,
      })
      settleLog(id, 'success', `status ${receipt.status}`, receipt.hash)
      await refresh(session.accountAddress)
    } catch (err) {
      settleLog(id, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [provider, session, pushLog, settleLog, refresh])

  const explorerTx = (hash: string) =>
    cfg.explorerBase ? `${cfg.explorerBase}/tx/${hash}` : null

  return (
    <main className="container">
      <h1>Cofferdam — Native AA (passkey)</h1>
      <p className="lead">
        <code>NativeAccountProvider</code> against <strong>{cfg.label}</strong> (chainId{' '}
        {cfg.chainId}). Sign-in derives a High-tier P-256 passkey and the smart account's
        counterfactual address; the account then transacts gaslessly via the paymaster.
      </p>

      {!configured && (
        <div className="lead">
          <strong>Not configured.</strong> Set the following in <code>.env.local</code> (deploy
          with <code>yarn deploy:auth:local &amp;&amp; yarn deploy:native:local</code>, then copy
          the addresses from <code>contracts/deployments/inMemoryNode.json</code>):
          <ul>
            {!cfg.factory && <li>VITE_NATIVE_FACTORY_ADDRESS</li>}
            {!cfg.paymaster && <li>VITE_NATIVE_PAYMASTER_ADDRESS</li>}
            {!cfg.passkeyModule && <li>VITE_NATIVE_PASSKEY_MODULE_ADDRESS</li>}
            {!cfg.adminPrivateKey && <li>VITE_NATIVE_ADMIN_PRIVATE_KEY (testnet has no default)</li>}
          </ul>
        </div>
      )}

      <div className="actions">
        <button onClick={signIn} disabled={!configured || busy !== null}>
          {busy === 'signin' ? '…' : '1. Sign in'}
        </button>
        <button onClick={deploy} disabled={!session || busy !== null}>
          {busy === 'deploy' ? '…' : '2. Deploy account'}
        </button>
        <button onClick={fundPaymaster} disabled={!configured || busy !== null}>
          {busy === 'fund' ? '…' : 'Fund paymaster'}
        </button>
        <button onClick={sendSponsored} disabled={!session || busy !== null}>
          {busy === 'send' ? '…' : '3. Send sponsored tx'}
        </button>
      </div>

      {session && (
        <pre className="session">
          {JSON.stringify(
            {
              appPseudonym: session.appPseudonym,
              accountAddress: session.accountAddress,
              authority: session.authority,
              accountDeployed: authority?.accountDeployed ?? session.accountDeployed,
              passkeyCount: authority?.passkeyCount,
              upgradeLocked: authority?.upgradeLocked,
              accountBalanceWei: balance?.toString(),
            },
            null,
            2,
          )}
        </pre>
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
                    {e.hash}
                  </a>
                ) : (
                  <code className="activity-hash">{e.hash}</code>
                ))}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
