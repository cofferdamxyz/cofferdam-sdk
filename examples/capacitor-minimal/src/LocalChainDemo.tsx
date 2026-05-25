// Interactive harness for the v1/zksync contracts. Drives the same UI + flow
// against either of two networks, selected by the `chain` prop:
//
//   - chain="local"   : anvil-zksync (in-memory ZKSync Era node).
//                       Reads VITE_LOCAL_* env vars; defaults are anvil's
//                       public rich-wallet #0 + http://127.0.0.1:8011.
//                       Demo amounts: 0.1 ETH per job, 0.5–1.5 ETH pre-funds.
//
//   - chain="testnet" : ZKSync Era Sepolia (chainId 300).
//                       Reads VITE_TESTNET_* env vars. Defaults to the
//                       deployed Receiver/Escrow addresses (see README §6),
//                       Sepolia public RPC, scaled-down amounts (~100×
//                       smaller so the admin's faucet ETH lasts more than 2
//                       runs), clickable block-explorer links on every tx.
//                       VITE_TESTNET_ADMIN_PRIVATE_KEY MUST be set — there's
//                       no public default for a testnet admin.
//
// Three roles in a single page, each backed by its own `LocalChainProvider`:
//
//   - Recruiter (HR)   : drafts contracts, awards workers
//   - Funder    (CFO)  : pays the locked amount for drafts they were designated for
//   - Worker    (Crew) : checks in / out, receives the settled payout
//
// Every on-chain action produces a row in the Activity log with a status
// (pending → success / error), tx hash, and a one-line summary.
//
// Notes:
//   - The "admin private key" binds identities + pre-funds role EOAs. On
//     local mode it defaults to anvil's public rich-wallet #0; on testnet
//     mode it MUST be supplied by the operator and must hold L2 ETH. NEVER
//     reuse anvil's key on testnet — it's public.
//   - The recruiter / funder / worker EOAs are deterministic from their
//     mockUserId env vars; re-running with the same IDs reuses the same
//     accounts (so binds are idempotent and skipped on repeat sessions).
//   - We re-derive each role's wallet client-side after signIn() because the
//     SDK doesn't expose a signer (yet). Tracked in TODO.md under "high-level
//     escrow client on the SDK".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Provider as ZkProvider,
  Wallet as ZkWallet,
} from 'zksync-ethers'
import { LocalChainProvider } from '@cofferdam/sdk/local'
import {
  OffshoreSyncEscrowClient,
  OPEN_FUNDING,
  type SignInResponse,
} from '@cofferdam/sdk'
import { useFunderPicker } from '@cofferdam/sdk-react'

// ────────────────────────────────────────────────────────────────────────────
// Env-driven config
// ────────────────────────────────────────────────────────────────────────────

export type ChainTarget = 'local' | 'testnet'

interface ChainConfig {
  rpcUrl: string
  chainId: number
  receiver: string
  escrow: string
  adminPrivateKey: string
  recruiterId: string
  funderId: string
  workerId: string
  amountWei: bigint
  prefunds: { recruiter: bigint; funder: bigint; worker: bigint }
  label: string
  explorerBase: string | null // null on local; full origin on testnet (e.g. https://sepolia.explorer.zksync.io)
}

// Anvil-zksync's public rich-wallet #0. Fully public, hard-coded in the
// vendored binary — fine for local dev, NEVER use it where there's value.
const ANVIL_RICH_WALLET_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// Sepolia α-2 deploy from May 2026 — see README §6 + contracts/deployments/
// zkSyncSepolia.json. Hard-coded as the default for the testnet demo so
// users don't have to copy-paste addresses; can still be overridden via
// VITE_TESTNET_*_ADDRESS if a fresh redeploy happens.
const SEPOLIA_DEFAULTS = {
  receiver: '0xa8F46B15F53D619584a00b91559e37233869ab5a',
  escrow: '0x22281d75CF1d34421e5Fc58625885b46dC309723',
} as const

function buildConfig(chain: ChainTarget): ChainConfig {
  const env = import.meta.env
  if (chain === 'testnet') {
    return {
      rpcUrl:
        (env.VITE_TESTNET_RPC_URL as string | undefined) ??
        'https://sepolia.era.zksync.dev',
      chainId: Number(env.VITE_TESTNET_CHAIN_ID ?? 300),
      receiver:
        (env.VITE_TESTNET_RECEIVER_ADDRESS as string | undefined) ??
        SEPOLIA_DEFAULTS.receiver,
      escrow:
        (env.VITE_TESTNET_ESCROW_ADDRESS as string | undefined) ??
        SEPOLIA_DEFAULTS.escrow,
      // No default for testnet admin — there's no public-key analog of anvil's
      // rich wallet. Empty string here surfaces a clear error in the UI before
      // anything tries to sign.
      adminPrivateKey: (env.VITE_TESTNET_ADMIN_PRIVATE_KEY as string | undefined) ?? '',
      recruiterId:
        (env.VITE_TESTNET_RECRUITER_ID as string | undefined) ?? 'sepolia-recruiter-1',
      funderId:
        (env.VITE_TESTNET_FUNDER_ID as string | undefined) ?? 'sepolia-finance-1',
      workerId:
        (env.VITE_TESTNET_WORKER_ID as string | undefined) ?? 'sepolia-worker-1',
      // Scaled 100× smaller than local so a 0.05 ETH faucet stash covers
      // ~25 full demo runs instead of ~2.
      amountWei: 1_000_000_000_000_000n, // 0.001 ETH per demo job
      prefunds: {
        recruiter: 5_000_000_000_000_000n, // 0.005 ETH (gas only)
        funder: 15_000_000_000_000_000n, // 0.015 ETH (covers amount + gas)
        worker: 5_000_000_000_000_000n, // 0.005 ETH (gas only)
      },
      label: 'ZKSync Era Sepolia',
      explorerBase: 'https://sepolia.explorer.zksync.io',
    }
  }
  // chain === 'local'
  return {
    rpcUrl:
      (env.VITE_LOCAL_RPC_URL as string | undefined) ?? 'http://127.0.0.1:8011',
    chainId: Number(env.VITE_LOCAL_CHAIN_ID ?? 260),
    receiver: (env.VITE_LOCAL_RECEIVER_ADDRESS as string | undefined) ?? '',
    escrow: (env.VITE_LOCAL_ESCROW_ADDRESS as string | undefined) ?? '',
    adminPrivateKey:
      (env.VITE_LOCAL_ADMIN_PRIVATE_KEY as string | undefined) ?? ANVIL_RICH_WALLET_PK,
    recruiterId:
      (env.VITE_LOCAL_RECRUITER_ID as string | undefined) ?? 'local-recruiter-1',
    funderId: (env.VITE_LOCAL_FUNDER_ID as string | undefined) ?? 'local-finance-1',
    workerId: (env.VITE_LOCAL_WORKER_ID as string | undefined) ?? 'local-worker-1',
    amountWei: 100_000_000_000_000_000n, // 0.1 ETH per demo job
    prefunds: {
      recruiter: 500_000_000_000_000_000n, // 0.5 ETH
      funder: 1_500_000_000_000_000_000n, // 1.5 ETH (covers amount + gas)
      worker: 100_000_000_000_000_000n, // 0.1 ETH (gas only)
    },
    label: 'anvil-zksync (local)',
    explorerBase: null,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type Role = 'recruiter' | 'funder' | 'worker'

interface RoleConfig {
  mockUserId: string
  prefundWei: bigint
  label: string
  emoji: string
}

// Static role metadata (label/emoji) — the dynamic bits (mockUserId,
// prefundWei) come from the per-mode `cfg` and are merged at render time.
const ROLE_META: Record<Role, { label: string; emoji: string }> = {
  recruiter: { label: 'Recruiter (HR)', emoji: '👤' },
  funder: { label: 'Funder (Finance)', emoji: '💼' },
  worker: { label: 'Worker (Crew)', emoji: '⚓' },
}

function buildRoles(cfg: ChainConfig): Record<Role, RoleConfig> {
  return {
    recruiter: {
      mockUserId: cfg.recruiterId,
      prefundWei: cfg.prefunds.recruiter,
      ...ROLE_META.recruiter,
    },
    funder: {
      mockUserId: cfg.funderId,
      prefundWei: cfg.prefunds.funder,
      ...ROLE_META.funder,
    },
    worker: {
      mockUserId: cfg.workerId,
      prefundWei: cfg.prefunds.worker,
      ...ROLE_META.worker,
    },
  }
}

interface RoleState {
  session: SignInResponse | null
  wallet: ZkWallet | null
  balance: bigint | null
  signing: boolean
  error: string | null
}

interface TxEntry {
  id: string
  label: string
  status: 'pending' | 'success' | 'error'
  hash?: string
  error?: string
  contractId?: bigint
  // Captured at tx creation so the activity row can render a clickable
  // explorer link without having to know the current `chain` prop.
  explorerBase?: string | null
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

// Mirror of LocalChainProvider.deriveDeterministicPrivateKey. The SDK doesn't
// expose this yet; once it does (TODO: getSigner()), drop this.
async function deriveDeterministicPk(mockUserId: string): Promise<string> {
  const salt = 'cofferdam-local-privatekey-v1'
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(mockUserId))
  const bytes = new Uint8Array(sig)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0')
  return '0x' + hex
}

function shortAddr(addr: string | null | undefined): string {
  if (!addr) return '—'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function fmtEth(wei: bigint | null): string {
  if (wei == null) return '—'
  // 18 decimals → quick truncating formatter (good enough for a demo UI).
  const whole = wei / 1_000_000_000_000_000_000n
  const frac = wei % 1_000_000_000_000_000_000n
  const fracStr = frac.toString().padStart(18, '0').slice(0, 4)
  return `${whole}.${fracStr} ETH`
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

interface LocalChainDemoProps {
  chain: ChainTarget
}

export function LocalChainDemo({ chain }: LocalChainDemoProps) {
  const cfg = useMemo(() => buildConfig(chain), [chain])
  const rolesMeta = useMemo(() => buildRoles(cfg), [cfg])
  const rpc = useMemo(() => new ZkProvider(cfg.rpcUrl), [cfg.rpcUrl])

  // Configured = enough info to actually fire txs. Receiver/Escrow always
  // have defaults on testnet (the deployed Sepolia addresses), but the
  // adminPrivateKey has no public default — testnet operators must supply
  // their own funded key. Local mode falls back to anvil's rich wallet.
  const missingAdmin = !cfg.adminPrivateKey
  const missingAddrs = !cfg.receiver || !cfg.escrow
  const configured = !missingAddrs && !missingAdmin

  const [roles, setRoles] = useState<Record<Role, RoleState>>({
    recruiter: emptyRoleState(),
    funder: emptyRoleState(),
    worker: emptyRoleState(),
  })
  const [txs, setTxs] = useState<TxEntry[]>([])
  const [lastContractId, setLastContractId] = useState<bigint | null>(null)

  // Corporate-flow funder picker. The signed-in Finance role is offered as a
  // suggestion (the canonical demo path), but the recruiter is free to type
  // any address or pick OPEN_FUNDING. Persisted per chain target so flipping
  // between local/testnet doesn't cross-contaminate recent picks.
  const funderSuggestions = useMemo(() => {
    const finance = roles.funder.session?.accountAddress
    if (!finance) return []
    return [{ address: finance, label: 'Sign-in: Finance' }]
  }, [roles.funder.session?.accountAddress])
  const funderPicker = useFunderPicker({
    suggestions: funderSuggestions,
    storageKey: `cofferdam:funders:capacitor-minimal:${chain}`,
  })

  // Resolve which address to actually pass to postContractIntent: picker
  // selection wins, fall back to the signed-in Finance role for one-click
  // demo continuity.
  const designatedFunderAddress =
    funderPicker.selectedFunder?.address ?? roles.funder.session?.accountAddress ?? null

  const updateRole = useCallback((role: Role, patch: Partial<RoleState>) => {
    setRoles((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }))
  }, [])

  // Reset role state if the chain target ever changes mid-session (defensive
  // — today the prop is build-time-fixed, but if it ever isn't we don't want
  // a wallet bound to network A leaking into network B's session).
  useEffect(() => {
    setRoles({
      recruiter: emptyRoleState(),
      funder: emptyRoleState(),
      worker: emptyRoleState(),
    })
    setTxs([])
    setLastContractId(null)
  }, [chain])

  // Live balance refresher.
  //
  // Two paths feed it:
  //   1. A 4-second `setInterval` safety net — picks up changes caused by
  //      txs we *didn't* initiate from this tab (e.g. the worker's balance
  //      bumping when another role calls `settle`).
  //   2. Direct invocation from each tx handler's success path — catches
  //      our own txs within milliseconds of confirmation, so the UI feels
  //      truly live.
  //
  // We read `roles` from a ref so the polling effect doesn't tear down
  // every time a balance update lands. Earlier versions listed `roles`
  // in the effect deps, which created a feedback loop where each balance
  // write cancelled the interval before the next role finished refreshing.
  const rolesRef = useRef(roles)
  useEffect(() => {
    rolesRef.current = roles
  }, [roles])

  const refreshBalances = useCallback(async () => {
    const current = rolesRef.current
    await Promise.all(
      (Object.keys(current) as Role[]).map(async (role) => {
        const addr = current[role].session?.accountAddress
        if (!addr) return
        try {
          const bal = await rpc.getBalance(addr)
          updateRole(role, { balance: bal })
        } catch {
          /* node not reachable, swallow */
        }
      }),
    )
  }, [rpc, updateRole])

  useEffect(() => {
    void refreshBalances()
    const t = setInterval(() => void refreshBalances(), 4000)
    return () => clearInterval(t)
  }, [refreshBalances])

  // ── Sign-in flow ────────────────────────────────────────────────────
  const signIn = useCallback(
    async (role: Role) => {
      if (!configured) return
      updateRole(role, { signing: true, error: null })
      const meta = rolesMeta[role]
      const provider = new LocalChainProvider({
        scope: 'capacitor-minimal',
        rpcUrl: cfg.rpcUrl,
        chainId: cfg.chainId,
        contracts: { receiver: cfg.receiver, escrow: cfg.escrow },
        mockUserId: meta.mockUserId,
        adminPrivateKey: cfg.adminPrivateKey,
        prefundWei: meta.prefundWei,
      })
      const tx = newTx(setTxs, `${meta.emoji} sign-in: ${meta.label}`, cfg.explorerBase)
      try {
        const session = await provider.signIn({})
        const pk = await deriveDeterministicPk(meta.mockUserId)
        const wallet = new ZkWallet(pk, rpc)
        updateRole(role, { session, wallet, signing: false })
        tx.success()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        updateRole(role, { signing: false, error: msg })
        tx.error(msg)
      }
    },
    [cfg, rolesMeta, rpc, configured, updateRole],
  )

  // ── Escrow actions ───────────────────────────────────────────────────
  //
  // All flows go through `OffshoreSyncEscrowClient` from @cofferdam/sdk.
  // The client owns: ABI, event decoding, contract-id extraction, and the
  // status enum. We just wire it to each role's signing wallet and surface
  // the tx hash to the activity log via the `onSent` hook.
  const escrowFor = useCallback(
    (wallet: ZkWallet) =>
      new OffshoreSyncEscrowClient({ address: cfg.escrow, signer: wallet }),
    [cfg.escrow],
  )

  const postSelfFunded = useCallback(async () => {
    const wallet = roles.recruiter.wallet
    if (!wallet) return
    const escrow = escrowFor(wallet)
    const termsHash = OffshoreSyncEscrowClient.hashTerms(`self-${Date.now()}`)
    const tx = newTx(
      setTxs,
      `🧾 postContract (self-funded, ${fmtEth(cfg.amountWei)})`,
      cfg.explorerBase,
    )
    try {
      const { contractId } = await escrow.postContract(termsHash, cfg.amountWei, {
        onSent: (h) => tx.setHash(h),
      })
      setLastContractId(contractId)
      tx.successWithContract(contractId)
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.recruiter.wallet, escrowFor, cfg.amountWei, cfg.explorerBase, refreshBalances])

  const postIntent = useCallback(async () => {
    const wallet = roles.recruiter.wallet
    if (!wallet || !designatedFunderAddress) return
    const escrow = escrowFor(wallet)
    const termsHash = OffshoreSyncEscrowClient.hashTerms(`intent-${Date.now()}`)
    const isOpenFunding = designatedFunderAddress === OPEN_FUNDING
    const tx = newTx(
      setTxs,
      isOpenFunding
        ? `🧾 postContractIntent (${fmtEth(cfg.amountWei)} → open funding)`
        : `🧾 postContractIntent (${fmtEth(cfg.amountWei)} → ${shortAddr(designatedFunderAddress)})`,
      cfg.explorerBase,
    )
    try {
      const { contractId } = await escrow.postContractIntent(
        termsHash,
        cfg.amountWei,
        designatedFunderAddress,
        { onSent: (h) => tx.setHash(h) },
      )
      setLastContractId(contractId)
      tx.successWithContract(contractId)
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [
    roles.recruiter.wallet,
    designatedFunderAddress,
    escrowFor,
    cfg.amountWei,
    cfg.explorerBase,
    refreshBalances,
  ])

  const fundContract = useCallback(async () => {
    const wallet = roles.funder.wallet
    if (!wallet || lastContractId == null) return
    const escrow = escrowFor(wallet)
    const tx = newTx(
      setTxs,
      `💸 fundContract #${lastContractId} (${fmtEth(cfg.amountWei)})`,
      cfg.explorerBase,
    )
    try {
      await escrow.fundContract(lastContractId, cfg.amountWei, {
        onSent: (h) => tx.setHash(h),
      })
      tx.successWithContract(lastContractId)
      void refreshBalances()
      // Bump the funder up the recent list so re-running with a fresh
      // recruiter ID surfaces them first.
      const addr = roles.funder.session?.accountAddress
      if (addr) funderPicker.recordUsage(addr, 'Sign-in: Finance')
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [
    roles.funder.wallet,
    roles.funder.session?.accountAddress,
    lastContractId,
    escrowFor,
    cfg.amountWei,
    cfg.explorerBase,
    funderPicker,
    refreshBalances,
  ])

  const awardWorker = useCallback(async () => {
    const wallet = roles.recruiter.wallet
    const workerAddr = roles.worker.session?.accountAddress
    if (!wallet || !workerAddr || lastContractId == null) return
    const escrow = escrowFor(wallet)
    const tx = newTx(
      setTxs,
      `🏷  awardContract #${lastContractId} → ${shortAddr(workerAddr)}`,
      cfg.explorerBase,
    )
    try {
      await escrow.awardContract(lastContractId, workerAddr, {
        onSent: (h) => tx.setHash(h),
      })
      tx.successWithContract(lastContractId)
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [
    roles.recruiter.wallet,
    roles.worker.session?.accountAddress,
    lastContractId,
    escrowFor,
    cfg.explorerBase,
    refreshBalances,
  ])

  const checkIn = useCallback(async () => {
    const wallet = roles.worker.wallet
    if (!wallet || lastContractId == null) return
    const escrow = escrowFor(wallet)
    const tx = newTx(setTxs, `🕒 checkIn #${lastContractId}`, cfg.explorerBase)
    try {
      await escrow.checkIn(lastContractId, { onSent: (h) => tx.setHash(h) })
      tx.successWithContract(lastContractId)
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.worker.wallet, lastContractId, escrowFor, cfg.explorerBase, refreshBalances])

  const checkOut = useCallback(async () => {
    const wallet = roles.worker.wallet
    if (!wallet || lastContractId == null) return
    const escrow = escrowFor(wallet)
    const tx = newTx(setTxs, `🕔 checkOut #${lastContractId}`, cfg.explorerBase)
    try {
      await escrow.checkOut(lastContractId, { onSent: (h) => tx.setHash(h) })
      tx.successWithContract(lastContractId)
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.worker.wallet, lastContractId, escrowFor, cfg.explorerBase, refreshBalances])

  const settle = useCallback(async () => {
    // Any signed-in wallet can call settle. We use the recruiter for parity
    // with the integration test; in production the Cofferdam paymaster bot does.
    const wallet = roles.recruiter.wallet ?? roles.funder.wallet ?? roles.worker.wallet
    if (!wallet || lastContractId == null) return
    const escrow = escrowFor(wallet)
    const tx = newTx(setTxs, `✅ settle #${lastContractId}`, cfg.explorerBase)
    try {
      await escrow.settle(lastContractId, { onSent: (h) => tx.setHash(h) })
      tx.successWithContract(lastContractId)
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [
    roles.recruiter.wallet,
    roles.funder.wallet,
    roles.worker.wallet,
    lastContractId,
    escrowFor,
    cfg.explorerBase,
    refreshBalances,
  ])

  // ── Render ─────────────────────────────────────────────────────────────
  const title = chain === 'testnet' ? 'Cofferdam Sepolia Demo' : 'Cofferdam Local-Chain Demo'
  if (!configured) {
    return (
      <main className="container container-wide">
        <h1>{title}</h1>
        {missingAddrs && chain === 'local' && (
          <p className="lead">
            Missing <code>VITE_LOCAL_RECEIVER_ADDRESS</code> /{' '}
            <code>VITE_LOCAL_ESCROW_ADDRESS</code> in <code>.env.local</code>.
            Run <code>yarn deploy:v1-zksync:local</code> in the contracts repo
            first, then paste the addresses it printed into{' '}
            <code>examples/capacitor-minimal/.env.local</code> (see{' '}
            <code>.env.example</code>) and restart <code>yarn dev:local-chain</code>.
          </p>
        )}
        {missingAddrs && chain === 'testnet' && (
          <p className="lead">
            Missing <code>VITE_TESTNET_RECEIVER_ADDRESS</code> /{' '}
            <code>VITE_TESTNET_ESCROW_ADDRESS</code>. The defaults baked into
            this demo point at the May-2026 Sepolia deploy; if you've
            overridden them in <code>.env.local</code> they must both be set.
          </p>
        )}
        {missingAdmin && chain === 'testnet' && (
          <p className="lead">
            Missing <code>VITE_TESTNET_ADMIN_PRIVATE_KEY</code>. Sepolia mode
            requires a funded EOA that owns the deployed{' '}
            <code>OffshoreSyncReceiver</code> — it signs <code>bindNullifier</code>{' '}
            for new sign-ins and pays gas + pre-fund transfers. Add it to{' '}
            <code>.env.local</code> and restart Vite. The deployer key from{' '}
            <code>contracts/.env</code> is the one you want; keep it topped up
            with ~0.05 L2 ETH from a Sepolia faucet.
          </p>
        )}
      </main>
    )
  }

  const lead =
    chain === 'testnet'
      ? `Three roles, one ZKSync Sepolia deployment. Sign each role in, then drive the corporate flow on-chain. Demo amounts are scaled 100× smaller (${fmtEth(cfg.amountWei)} per job) so the admin's faucet ETH lasts.`
      : 'Three roles, one anvil-zksync node. Sign each role in, then drive the corporate flow on-chain. Watch the activity log + your node terminal side-by-side.'

  return (
    <main className="container container-wide">
      <h1>
        {title}
        {chain === 'testnet' && (
          <span className="chain-badge" title="ZKSync Era Sepolia (chainId 300)">
            {' '}testnet
          </span>
        )}
      </h1>
      <p className="lead">{lead}</p>
      <div className="chain-meta">
        <div>
          <strong>Network:</strong> {cfg.label} · <strong>RPC:</strong>{' '}
          <code>{cfg.rpcUrl}</code> · chain {cfg.chainId}
        </div>
        <div>
          <strong>Receiver:</strong>{' '}
          {cfg.explorerBase ? (
            <a
              href={`${cfg.explorerBase}/address/${cfg.receiver}`}
              target="_blank"
              rel="noreferrer"
            >
              <code>{shortAddr(cfg.receiver)}</code>
            </a>
          ) : (
            <code>{shortAddr(cfg.receiver)}</code>
          )}
          {' · '}
          <strong>Escrow:</strong>{' '}
          {cfg.explorerBase ? (
            <a
              href={`${cfg.explorerBase}/address/${cfg.escrow}`}
              target="_blank"
              rel="noreferrer"
            >
              <code>{shortAddr(cfg.escrow)}</code>
            </a>
          ) : (
            <code>{shortAddr(cfg.escrow)}</code>
          )}
        </div>
      </div>

      <div className="role-grid">
        {(Object.keys(rolesMeta) as Role[]).map((role) => (
          <RolePanel
            key={role}
            role={role}
            meta={rolesMeta[role]}
            state={roles[role]}
            onSignIn={() => signIn(role)}
          />
        ))}
      </div>

      <FunderPickerPanel
        picker={funderPicker}
        chainExplorerBase={cfg.explorerBase}
        signedInFunder={roles.funder.session?.accountAddress ?? null}
      />

      <h2 className="section-h">Actions</h2>
      <div className="actions">
        <button
          className="action"
          onClick={postSelfFunded}
          disabled={!roles.recruiter.wallet}
          title="Recruiter posts a self-funded contract (α-2 path). 1 tx."
        >
          1️⃣ Post self-funded job
        </button>
        <button
          className="action"
          onClick={postIntent}
          disabled={!roles.recruiter.wallet || !designatedFunderAddress}
          title="Recruiter drafts a contract designating the picked funder. 1 tx, no funds yet."
        >
          1️⃣ Post intent →{' '}
          {designatedFunderAddress === OPEN_FUNDING
            ? 'open'
            : shortAddr(designatedFunderAddress)}
        </button>
        <button
          className="action"
          onClick={fundContract}
          disabled={!roles.funder.wallet || lastContractId == null}
          title="Finance funds the latest draft. 1 tx, transfers the locked amount into escrow."
        >
          2️⃣ Fund contract #{lastContractId?.toString() ?? '—'}
        </button>
        <button
          className="action"
          onClick={awardWorker}
          disabled={!roles.recruiter.wallet || !roles.worker.session || lastContractId == null}
          title="Recruiter awards the worker for the latest contract. 1 tx."
        >
          3️⃣ Award worker
        </button>
        <button
          className="action"
          onClick={checkIn}
          disabled={!roles.worker.wallet || lastContractId == null}
        >
          4️⃣ Check in
        </button>
        <button
          className="action"
          onClick={checkOut}
          disabled={!roles.worker.wallet || lastContractId == null}
        >
          5️⃣ Check out
        </button>
        <button
          className="action action-settle"
          onClick={settle}
          disabled={lastContractId == null || (!roles.recruiter.wallet && !roles.funder.wallet && !roles.worker.wallet)}
          title="Settle pays the worker. Any signed-in role can call it; we use the recruiter."
        >
          6️⃣ Settle (pay worker)
        </button>
      </div>

      <h2 className="section-h">Activity</h2>
      {txs.length === 0 ? (
        <p className="empty">No transactions yet. Sign someone in to start.</p>
      ) : (
        <ul className="activity">
          {txs.map((t) => (
            <li key={t.id} className={`activity-row activity-${t.status}`}>
              <span className="activity-status">
                {t.status === 'pending' ? '⏳' : t.status === 'success' ? '✓' : '✗'}
              </span>
              <span className="activity-label">{t.label}</span>
              {t.contractId != null && (
                <span className="activity-cid">contract #{t.contractId.toString()}</span>
              )}
              {t.hash &&
                (t.explorerBase ? (
                  <a
                    className="activity-hash"
                    href={`${t.explorerBase}/tx/${t.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <code>{shortAddr(t.hash)}</code>
                  </a>
                ) : (
                  <code className="activity-hash">{shortAddr(t.hash)}</code>
                ))}
              {t.error && <span className="activity-error">{t.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Subcomponents + tiny utils
// ────────────────────────────────────────────────────────────────────────────

interface RolePanelProps {
  role: Role
  meta: RoleConfig
  state: RoleState
  onSignIn: () => void
}

function RolePanel({ meta, state, onSignIn }: RolePanelProps) {
  const signedIn = state.session != null
  return (
    <div className={`role-panel ${signedIn ? 'role-panel-on' : ''}`}>
      <div className="role-header">
        <span className="role-emoji">{meta.emoji}</span>
        <div>
          <div className="role-label">{meta.label}</div>
          <div className="role-id">
            id: <code>{meta.mockUserId}</code>
          </div>
        </div>
      </div>
      {signedIn ? (
        <div className="role-body">
          <div className="role-line">
            <span>account</span>
            <code>{shortAddr(state.session!.accountAddress)}</code>
          </div>
          <div className="role-line">
            <span>balance</span>
            <code>{fmtEth(state.balance)}</code>
          </div>
          <div className="role-line">
            <span>pseudonym</span>
            <code>{state.session!.appPseudonym.slice(0, 18)}…</code>
          </div>
        </div>
      ) : (
        <button className="role-signin" onClick={onSignIn} disabled={state.signing}>
          {state.signing ? 'Signing in…' : `Sign in as ${meta.label}`}
        </button>
      )}
      {state.error && <div className="role-error">{state.error}</div>}
    </div>
  )
}

function emptyRoleState(): RoleState {
  return { session: null, wallet: null, balance: null, signing: false, error: null }
}

// ────────────────────────────────────────────────────────────────────────────
// Funder picker UI
// ────────────────────────────────────────────────────────────────────────────
//
// Small inline UI exercising `useFunderPicker` from @cofferdam/sdk-react.
// Renders:
//   - candidate chips (signed-in Finance role + recents)
//   - a manual-paste input for ad-hoc addresses
//   - an "open funding" toggle (sends address(0) to the contract)
// The picker itself owns dedup/persistence; this component is just chrome.

interface FunderPickerPanelProps {
  picker: ReturnType<typeof useFunderPicker>
  chainExplorerBase: string | null
  signedInFunder: string | null
}

function FunderPickerPanel({
  picker,
  chainExplorerBase,
  signedInFunder,
}: FunderPickerPanelProps) {
  const [manual, setManual] = useState('')
  const selected = picker.selectedFunder
  const isOpen = selected?.address === OPEN_FUNDING
  const fallback = !selected && signedInFunder
    ? { address: signedInFunder, label: 'Sign-in: Finance (default)' }
    : null
  const effective = selected ?? fallback

  const tryManual = () => {
    const trimmed = manual.trim()
    if (!picker.isValidAddress(trimmed)) return
    picker.selectFunderByAddress(trimmed, 'Manual entry')
    setManual('')
  }

  return (
    <div className="funder-picker">
      <h2 className="section-h">Designated funder (corporate flow)</h2>
      <p className="funder-hint">
        Picked address is passed to <code>postContractIntent</code> as{' '}
        <code>designatedFunder</code>. Choose <em>open funding</em> to allow any
        Cofferdam-bound account to fund the draft.
      </p>

      <div className="funder-selected">
        <strong>Selected:</strong>{' '}
        {effective ? (
          <>
            {isOpen ? (
              <code>OPEN_FUNDING (address(0))</code>
            ) : chainExplorerBase ? (
              <a
                href={`${chainExplorerBase}/address/${effective.address}`}
                target="_blank"
                rel="noreferrer"
              >
                <code>{shortAddr(effective.address)}</code>
              </a>
            ) : (
              <code>{shortAddr(effective.address)}</code>
            )}
            {effective.label && <span className="funder-label"> · {effective.label}</span>}
            {!selected && <span className="funder-label"> · (fallback)</span>}
          </>
        ) : (
          <span className="funder-empty">— sign Finance in or paste an address —</span>
        )}
      </div>

      <div className="funder-candidates">
        {picker.candidates.map((c) => {
          const active = selected?.address === c.address
          return (
            <button
              key={c.address}
              className={`funder-chip ${active ? 'funder-chip-on' : ''}`}
              onClick={() => picker.selectFunder(c)}
              title={c.address}
            >
              {c.label ?? shortAddr(c.address)}
              {c.lastUsedAt && <span className="funder-recent"> · recent</span>}
            </button>
          )
        })}
        <button
          className={`funder-chip funder-chip-open ${isOpen ? 'funder-chip-on' : ''}`}
          onClick={() =>
            picker.selectFunder({ address: OPEN_FUNDING, label: 'Open funding (any bound account)' })
          }
          title="address(0) — any Cofferdam-bound account can fund"
        >
          Open funding
        </button>
        {selected && (
          <button
            className="funder-chip funder-chip-clear"
            onClick={() => picker.selectFunder(null)}
            title="Fall back to the signed-in Finance role"
          >
            Clear
          </button>
        )}
      </div>

      <div className="funder-manual">
        <input
          type="text"
          placeholder="0x… manual address"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          spellCheck={false}
        />
        <button
          onClick={tryManual}
          disabled={!picker.isValidAddress(manual.trim())}
        >
          Use address
        </button>
        {picker.recent.length > 0 && (
          <button className="funder-clear-recent" onClick={picker.clearRecent}>
            Clear recents ({picker.recent.length})
          </button>
        )}
      </div>
    </div>
  )
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

interface TxHandle {
  setHash(hash: string): void
  success(): void
  successWithContract(cid: bigint): void
  error(msg: string): void
}

function newTx(
  setTxs: React.Dispatch<React.SetStateAction<TxEntry[]>>,
  label: string,
  explorerBase: string | null,
): TxHandle {
  const id = rid()
  setTxs((prev) => [{ id, label, status: 'pending', explorerBase }, ...prev])
  const patch = (p: Partial<TxEntry>) =>
    setTxs((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t)))
  return {
    setHash: (hash) => patch({ hash }),
    success: () => patch({ status: 'success' }),
    successWithContract: (cid) => patch({ status: 'success', contractId: cid }),
    error: (msg) => patch({ status: 'error', error: msg }),
  }
}

