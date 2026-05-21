// Local-chain interactive harness for the v1/zksync contracts.
//
// Three roles in a single page, each backed by its own `LocalChainProvider`:
//
//   - Recruiter (HR)   : drafts contracts, awards workers
//   - Funder    (CFO)  : pays the locked amount for drafts they were designated for
//   - Worker    (Crew) : checks in / out, receives the settled payout
//
// Every on-chain action produces a row in the Activity log with a status
// (pending → success / error), tx hash, and a one-line summary. Roles share
// the same anvil-zksync node and `OffshoreSync{Receiver,Escrow}` deployment;
// you see the full corporate flow land in real time.
//
// Notes:
//   - The "admin private key" used to bind identities is the anvil-zksync
//     rich wallet #0 (public). NEVER reuse this pattern outside local dev.
//   - The recruiter / funder / worker EOAs are deterministic from their
//     mockUserId env vars; re-running with the same IDs against a live
//     anvil-zksync session will reuse the same accounts (so binds are
//     idempotent).
//   - We re-derive each role's wallet client-side after signIn() because the
//     SDK doesn't expose a signer (yet). Tracked in TODO.md under "high-level
//     escrow client on the SDK".

import { useCallback, useEffect, useMemo, useState } from 'react'
import { keccak256, toUtf8Bytes, type Interface } from 'ethers'
import {
  Provider as ZkProvider,
  Wallet as ZkWallet,
  Contract as ZkContract,
} from 'zksync-ethers'
import { LocalChainProvider } from '@cofferdam/sdk/local'
import type { SignInResponse } from '@cofferdam/sdk'

// ────────────────────────────────────────────────────────────────────────────
// Env-driven config
// ────────────────────────────────────────────────────────────────────────────

const env = import.meta.env

const CONFIG = {
  rpcUrl: (env.VITE_LOCAL_RPC_URL as string | undefined) ?? 'http://127.0.0.1:8011',
  chainId: Number(env.VITE_LOCAL_CHAIN_ID ?? 260),
  receiver: (env.VITE_LOCAL_RECEIVER_ADDRESS as string | undefined) ?? '',
  escrow: (env.VITE_LOCAL_ESCROW_ADDRESS as string | undefined) ?? '',
  adminPrivateKey:
    (env.VITE_LOCAL_ADMIN_PRIVATE_KEY as string | undefined) ??
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  recruiterId: (env.VITE_LOCAL_RECRUITER_ID as string | undefined) ?? 'local-recruiter-1',
  funderId: (env.VITE_LOCAL_FUNDER_ID as string | undefined) ?? 'local-finance-1',
  workerId: (env.VITE_LOCAL_WORKER_ID as string | undefined) ?? 'local-worker-1',
}

const AMOUNT_WEI = 100_000_000_000_000_000n // 0.1 ETH per demo job

const ESCROW_ABI = [
  'function postContract(bytes32 termsHash) payable returns (uint256)',
  'function postContractIntent(bytes32 termsHash, uint256 amount, address designatedFunder) returns (uint256)',
  'function fundContract(uint256 contractId) payable',
  'function awardContract(uint256 contractId, address workerAccount)',
  'function checkIn(uint256 contractId)',
  'function checkOut(uint256 contractId)',
  'function settle(uint256 contractId)',
  'function getContract(uint256 contractId) view returns (tuple(address recruiter, address designatedFunder, address funder, address worker, uint256 amount, bytes32 termsHash, uint64 draftedAt, uint64 postedAt, uint64 awardedAt, uint64 checkedInAt, uint64 checkedOutAt, uint8 status))',
  'event ContractDrafted(uint256 indexed contractId, address indexed recruiter, address indexed designatedFunder, uint256 amount, bytes32 termsHash)',
  'event ContractPosted(uint256 indexed contractId, address indexed recruiter, uint256 amount, bytes32 termsHash)',
] as const

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

const ROLES: Record<Role, RoleConfig> = {
  recruiter: {
    mockUserId: CONFIG.recruiterId,
    prefundWei: 500_000_000_000_000_000n, // 0.5 ETH
    label: 'Recruiter (HR)',
    emoji: '👤',
  },
  funder: {
    mockUserId: CONFIG.funderId,
    prefundWei: 1_500_000_000_000_000_000n, // 1.5 ETH (covers amount + gas)
    label: 'Funder (Finance)',
    emoji: '💼',
  },
  worker: {
    mockUserId: CONFIG.workerId,
    prefundWei: 100_000_000_000_000_000n, // 0.1 ETH (gas only)
    label: 'Worker (Crew)',
    emoji: '⚓',
  },
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

export function LocalChainDemo() {
  const configured = CONFIG.receiver && CONFIG.escrow
  const chain = useMemo(() => new ZkProvider(CONFIG.rpcUrl), [])

  const [roles, setRoles] = useState<Record<Role, RoleState>>({
    recruiter: emptyRoleState(),
    funder: emptyRoleState(),
    worker: emptyRoleState(),
  })
  const [txs, setTxs] = useState<TxEntry[]>([])
  const [lastContractId, setLastContractId] = useState<bigint | null>(null)

  const updateRole = useCallback((role: Role, patch: Partial<RoleState>) => {
    setRoles((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }))
  }, [])

  // Periodically refresh on-chain balances for signed-in roles.
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      for (const role of Object.keys(roles) as Role[]) {
        const addr = roles[role].session?.accountAddress
        if (!addr) continue
        try {
          const bal = await chain.getBalance(addr)
          if (cancelled) return
          updateRole(role, { balance: bal })
        } catch {
          /* node not up, swallow */
        }
      }
    }
    refresh()
    const t = setInterval(refresh, 4000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [chain, roles, updateRole])

  // ── Sign-in flow ────────────────────────────────────────────────────────
  const signIn = useCallback(
    async (role: Role) => {
      if (!configured) return
      updateRole(role, { signing: true, error: null })
      const cfg = ROLES[role]
      const provider = new LocalChainProvider({
        scope: 'capacitor-minimal',
        rpcUrl: CONFIG.rpcUrl,
        chainId: CONFIG.chainId,
        contracts: { receiver: CONFIG.receiver, escrow: CONFIG.escrow },
        mockUserId: cfg.mockUserId,
        adminPrivateKey: CONFIG.adminPrivateKey,
        prefundWei: cfg.prefundWei,
      })
      const tx = newTx(setTxs, `${cfg.emoji} sign-in: ${cfg.label}`)
      try {
        const session = await provider.signIn({})
        const pk = await deriveDeterministicPk(cfg.mockUserId)
        const wallet = new ZkWallet(pk, chain)
        updateRole(role, { session, wallet, signing: false })
        tx.success()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        updateRole(role, { signing: false, error: msg })
        tx.error(msg)
      }
    },
    [chain, configured, updateRole],
  )

  // ── Escrow actions ──────────────────────────────────────────────────────
  const postSelfFunded = useCallback(async () => {
    const wallet = roles.recruiter.wallet
    if (!wallet) return
    const escrow = new ZkContract(CONFIG.escrow, ESCROW_ABI as any, wallet)
    const termsHash = keccak256(toUtf8Bytes(`self-${Date.now()}`))
    const tx = newTx(setTxs, `🧾 postContract (self-funded, ${fmtEth(AMOUNT_WEI)})`)
    try {
      const sent = await escrow.postContract(termsHash, { value: AMOUNT_WEI })
      tx.setHash(sent.hash)
      const receipt = await sent.wait()
      const cid = extractContractId(escrow.interface, receipt.logs, 'ContractPosted')
      if (cid) {
        setLastContractId(cid)
        tx.successWithContract(cid)
      } else {
        tx.success()
      }
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.recruiter.wallet])

  const postIntent = useCallback(async () => {
    const wallet = roles.recruiter.wallet
    const funderAddr = roles.funder.session?.accountAddress
    if (!wallet || !funderAddr) return
    const escrow = new ZkContract(CONFIG.escrow, ESCROW_ABI as any, wallet)
    const termsHash = keccak256(toUtf8Bytes(`intent-${Date.now()}`))
    const tx = newTx(
      setTxs,
      `🧾 postContractIntent (${fmtEth(AMOUNT_WEI)} → ${shortAddr(funderAddr)})`,
    )
    try {
      const sent = await escrow.postContractIntent(termsHash, AMOUNT_WEI, funderAddr)
      tx.setHash(sent.hash)
      const receipt = await sent.wait()
      const cid = extractContractId(escrow.interface, receipt.logs, 'ContractDrafted')
      if (cid) {
        setLastContractId(cid)
        tx.successWithContract(cid)
      } else {
        tx.success()
      }
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.recruiter.wallet, roles.funder.session?.accountAddress])

  const fundContract = useCallback(async () => {
    const wallet = roles.funder.wallet
    if (!wallet || lastContractId == null) return
    const escrow = new ZkContract(CONFIG.escrow, ESCROW_ABI as any, wallet)
    const tx = newTx(setTxs, `💸 fundContract #${lastContractId} (${fmtEth(AMOUNT_WEI)})`)
    try {
      const sent = await escrow.fundContract(lastContractId, { value: AMOUNT_WEI })
      tx.setHash(sent.hash)
      await sent.wait()
      tx.successWithContract(lastContractId)
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.funder.wallet, lastContractId])

  const awardWorker = useCallback(async () => {
    const wallet = roles.recruiter.wallet
    const workerAddr = roles.worker.session?.accountAddress
    if (!wallet || !workerAddr || lastContractId == null) return
    const escrow = new ZkContract(CONFIG.escrow, ESCROW_ABI as any, wallet)
    const tx = newTx(setTxs, `🏷  awardContract #${lastContractId} → ${shortAddr(workerAddr)}`)
    try {
      const sent = await escrow.awardContract(lastContractId, workerAddr)
      tx.setHash(sent.hash)
      await sent.wait()
      tx.successWithContract(lastContractId)
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.recruiter.wallet, roles.worker.session?.accountAddress, lastContractId])

  const checkIn = useCallback(async () => {
    const wallet = roles.worker.wallet
    if (!wallet || lastContractId == null) return
    const escrow = new ZkContract(CONFIG.escrow, ESCROW_ABI as any, wallet)
    const tx = newTx(setTxs, `🕒 checkIn #${lastContractId}`)
    try {
      const sent = await escrow.checkIn(lastContractId)
      tx.setHash(sent.hash)
      await sent.wait()
      tx.successWithContract(lastContractId)
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.worker.wallet, lastContractId])

  const checkOut = useCallback(async () => {
    const wallet = roles.worker.wallet
    if (!wallet || lastContractId == null) return
    const escrow = new ZkContract(CONFIG.escrow, ESCROW_ABI as any, wallet)
    const tx = newTx(setTxs, `🕔 checkOut #${lastContractId}`)
    try {
      const sent = await escrow.checkOut(lastContractId)
      tx.setHash(sent.hash)
      await sent.wait()
      tx.successWithContract(lastContractId)
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.worker.wallet, lastContractId])

  const settle = useCallback(async () => {
    // Any signed-in wallet can call settle. We use the recruiter for parity
    // with the integration test; in production the Cofferdam paymaster bot does.
    const wallet = roles.recruiter.wallet ?? roles.funder.wallet ?? roles.worker.wallet
    if (!wallet || lastContractId == null) return
    const escrow = new ZkContract(CONFIG.escrow, ESCROW_ABI as any, wallet)
    const tx = newTx(setTxs, `✅ settle #${lastContractId}`)
    try {
      const sent = await escrow.settle(lastContractId)
      tx.setHash(sent.hash)
      await sent.wait()
      tx.successWithContract(lastContractId)
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.recruiter.wallet, roles.funder.wallet, roles.worker.wallet, lastContractId])

  // ── Render ──────────────────────────────────────────────────────────────
  if (!configured) {
    return (
      <main className="container container-wide">
        <h1>Cofferdam Local-Chain Demo</h1>
        <p className="lead">
          Missing <code>VITE_LOCAL_RECEIVER_ADDRESS</code> /{' '}
          <code>VITE_LOCAL_ESCROW_ADDRESS</code> in <code>.env.local</code>.
        </p>
        <p className="lead">
          Run <code>yarn deploy:v1-zksync:local</code> in the contracts repo
          first, then paste the addresses it printed into{' '}
          <code>examples/capacitor-minimal/.env.local</code> (see{' '}
          <code>.env.example</code>) and restart <code>yarn dev:local-chain</code>.
        </p>
      </main>
    )
  }

  return (
    <main className="container container-wide">
      <h1>Cofferdam Local-Chain Demo</h1>
      <p className="lead">
        Three roles, one anvil-zksync node. Sign each role in, then drive the
        corporate flow on-chain. Watch the activity log + your node terminal
        side-by-side.
      </p>
      <div className="chain-meta">
        <div>
          <strong>RPC:</strong> <code>{CONFIG.rpcUrl}</code> · chain {CONFIG.chainId}
        </div>
        <div>
          <strong>Receiver:</strong> <code>{shortAddr(CONFIG.receiver)}</code>
          {' · '}
          <strong>Escrow:</strong> <code>{shortAddr(CONFIG.escrow)}</code>
        </div>
      </div>

      <div className="role-grid">
        {(Object.keys(ROLES) as Role[]).map((role) => (
          <RolePanel
            key={role}
            role={role}
            state={roles[role]}
            onSignIn={() => signIn(role)}
          />
        ))}
      </div>

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
          disabled={!roles.recruiter.wallet || !roles.funder.session}
          title="Recruiter drafts a contract designating Finance as the funder. 1 tx, no funds yet."
        >
          1️⃣ Post intent → Finance
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
              {t.hash && <code className="activity-hash">{shortAddr(t.hash)}</code>}
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
  state: RoleState
  onSignIn: () => void
}

function RolePanel({ role, state, onSignIn }: RolePanelProps) {
  const cfg = ROLES[role]
  const signedIn = state.session != null
  return (
    <div className={`role-panel ${signedIn ? 'role-panel-on' : ''}`}>
      <div className="role-header">
        <span className="role-emoji">{cfg.emoji}</span>
        <div>
          <div className="role-label">{cfg.label}</div>
          <div className="role-id">
            id: <code>{cfg.mockUserId}</code>
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
          {state.signing ? 'Signing in…' : `Sign in as ${cfg.label}`}
        </button>
      )}
      {state.error && <div className="role-error">{state.error}</div>}
    </div>
  )
}

function emptyRoleState(): RoleState {
  return { session: null, wallet: null, balance: null, signing: false, error: null }
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

function newTx(setTxs: React.Dispatch<React.SetStateAction<TxEntry[]>>, label: string): TxHandle {
  const id = rid()
  setTxs((prev) => [{ id, label, status: 'pending' }, ...prev])
  const patch = (p: Partial<TxEntry>) =>
    setTxs((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t)))
  return {
    setHash: (hash) => patch({ hash }),
    success: () => patch({ status: 'success' }),
    successWithContract: (cid) => patch({ status: 'success', contractId: cid }),
    error: (msg) => patch({ status: 'error', error: msg }),
  }
}

function extractContractId(
  iface: Interface,
  logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string; address: string }>,
  eventName: 'ContractDrafted' | 'ContractPosted',
): bigint | null {
  const ev = iface.getEvent(eventName)
  if (!ev) return null
  const topic = ev.topicHash
  const target = CONFIG.escrow.toLowerCase()
  for (const l of logs) {
    if (l.topics[0] !== topic) continue
    if (l.address.toLowerCase() !== target) continue
    const parsed = iface.parseLog({ topics: [...l.topics], data: l.data })
    if (!parsed) continue
    return parsed.args.contractId as bigint
  }
  return null
}
