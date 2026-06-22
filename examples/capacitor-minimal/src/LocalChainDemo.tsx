// Interactive harness for the Base contracts. Drives the same UI + flow
// against either of two networks, selected by the `chain` prop:
//
//   - chain="local"   : base-anvil (forked Base node).
//                       Reads VITE_LOCAL_* env vars; defaults are anvil's
//                       public rich-wallet #0 + http://127.0.0.1:8545.
//                       Demo amounts: 0.1 ETH per job, 0.5–1.5 ETH pre-funds.
//
//   - chain="testnet" : Base Sepolia (chainId 84532).
//                       Reads VITE_TESTNET_* env vars. Defaults to the
//                       deployed Receiver/Escrow addresses (see README §6),
//                       Base Sepolia public RPC, scaled-down amounts (~100×
//                       smaller so the admin's faucet ETH lasts more than 2
//                       runs), clickable block-explorer links on every tx.
//                       VITE_TESTNET_ADMIN_PRIVATE_KEY MUST be set — there's
//                       no public default for a testnet admin.
//
// Four roles in a single page, each backed by its own `LocalChainProvider`:
//
//   - Recruiter (HR)   : assigns/replaces the on-site supervisor as witness
//   - Funder    (CFO)  : approves USDC, funds the escrow, can refund/void
//   - Supervisor(Witness): checks worker in/out, attests work done
//   - Worker    (Crew) : assigned to vacancy, receives USDC on checkout
//
// Every on-chain action produces a row in the Activity log with a status
// (pending → success / error), tx hash, and a one-line summary.
//
// Notes:
//   - The "admin private key" binds identities + pre-funds role EOAs. On
//     local mode it defaults to anvil's public rich-wallet #0; on testnet
//     mode it MUST be supplied by the operator and must hold ETH. NEVER
//     reuse anvil's key on testnet — it's public.
//   - The recruiter / funder / worker EOAs are deterministic from their
//     mockUserId env vars; re-running with the same IDs reuses the same
//     accounts (so binds are idempotent and skipped on repeat sessions).
//   - We re-derive each role's wallet client-side after signIn() because the
//     SDK doesn't expose a signer (yet). Tracked in TODO.md under "high-level
//     escrow client on the SDK".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JsonRpcProvider, Wallet as EthersWallet, Contract as EthContract, id as ethersId, randomBytes, hexlify } from 'ethers'
import { LocalChainProvider } from '@cofferdam/sdk/local'
import {
  CofferdamSpotEscrowClient,
  CofferdamEscrowFactoryClient,
  type SignInResponse,
} from '@cofferdam/sdk'

// ────────────────────────────────────────────────────────────────────────────
// Env-driven config
// ────────────────────────────────────────────────────────────────────────────

export type ChainTarget = 'local' | 'testnet'

interface ChainConfig {
  rpcUrl: string
  chainId: number
  receiver: string
  escrow: string
  factoryAddress: string
  adminPrivateKey: string
  recruiterId: string
  funderId: string
  workerId: string
  supervisorId: string
  amountUsdc: bigint // 6-decimal USDC amount for escrow funding
  prefunds: { recruiter: bigint; funder: bigint; worker: bigint; supervisor: bigint }
  label: string
  explorerBase: string | null
}

// Anvil's public rich-wallet #0. Fully public, hard-coded in the
// binary — fine for local dev, NEVER use it where there's value.
const ANVIL_RICH_WALLET_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// Base Sepolia deploy — see README §6 + base-contracts/deployments/.
// Hard-coded as the default for the testnet demo so users don't have to
// copy-paste addresses; can still be overridden via VITE_TESTNET_*_ADDRESS
// if a fresh redeploy happens.
const SEPOLIA_DEFAULTS = {
  receiver: '',
  escrow: '',
  factoryAddress: '',
} as const

function buildConfig(chain: ChainTarget): ChainConfig {
  const env = import.meta.env
  if (chain === 'testnet') {
    return {
      rpcUrl:
        (env.VITE_TESTNET_RPC_URL as string | undefined) ??
        'https://sepolia.base.org',
      chainId: Number(env.VITE_TESTNET_CHAIN_ID ?? 84532),
      receiver:
        (env.VITE_TESTNET_RECEIVER_ADDRESS as string | undefined) ??
        SEPOLIA_DEFAULTS.receiver,
      escrow:
        (env.VITE_TESTNET_ESCROW_ADDRESS as string | undefined) ??
        SEPOLIA_DEFAULTS.escrow,
      factoryAddress:
        (env.VITE_TESTNET_FACTORY_ADDRESS as string | undefined) ??
        SEPOLIA_DEFAULTS.factoryAddress,
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
      supervisorId:
        (env.VITE_TESTNET_SUPERVISOR_ID as string | undefined) ?? 'sepolia-supervisor-1',
      // Scaled 100× smaller than local so a 0.05 ETH faucet stash covers
      // ~25 full demo runs instead of ~2.
      amountUsdc: 1_000_000n, // 1 USDC per demo job (6 decimals)
      prefunds: {
        recruiter: 5_000_000_000_000_000n, // 0.005 ETH (gas only)
        funder: 15_000_000_000_000_000n, // 0.015 ETH (gas + USDC for funding)
        worker: 5_000_000_000_000_000n, // 0.005 ETH (gas only)
        supervisor: 5_000_000_000_000_000n, // 0.005 ETH (gas only)
      },
      label: 'Base Sepolia',
      explorerBase: 'https://sepolia.basescan.org',
    }
  }
  // chain === 'local'
  return {
    rpcUrl:
      (env.VITE_LOCAL_RPC_URL as string | undefined) ?? 'http://127.0.0.1:8545',
    chainId: Number(env.VITE_LOCAL_CHAIN_ID ?? 31337),
    receiver: (env.VITE_LOCAL_RECEIVER_ADDRESS as string | undefined) ?? '',
    escrow: (env.VITE_LOCAL_ESCROW_ADDRESS as string | undefined) ?? '',
    factoryAddress: (env.VITE_LOCAL_FACTORY_ADDRESS as string | undefined) ?? '',
    adminPrivateKey:
      (env.VITE_LOCAL_ADMIN_PRIVATE_KEY as string | undefined) ?? ANVIL_RICH_WALLET_PK,
    recruiterId:
      (env.VITE_LOCAL_RECRUITER_ID as string | undefined) ?? 'local-recruiter-1',
    funderId: (env.VITE_LOCAL_FUNDER_ID as string | undefined) ?? 'local-finance-1',
    workerId: (env.VITE_LOCAL_WORKER_ID as string | undefined) ?? 'local-worker-1',
    supervisorId:
      (env.VITE_LOCAL_SUPERVISOR_ID as string | undefined) ?? 'local-supervisor-1',
    amountUsdc: 100_000_000n, // 100 USDC per demo job (6 decimals)
    prefunds: {
      recruiter: 500_000_000_000_000_000n, // 0.5 ETH (gas only)
      funder: 1_500_000_000_000_000_000n, // 1.5 ETH (gas + USDC for funding)
      worker: 100_000_000_000_000_000n, // 0.1 ETH (gas only)
      supervisor: 100_000_000_000_000_000n, // 0.1 ETH (gas only)
    },
    label: 'base-anvil (local)',
    explorerBase: null,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type Role = 'recruiter' | 'funder' | 'worker' | 'supervisor'

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
  supervisor: { label: 'Supervisor (Witness)', emoji: '🔧' },
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
    supervisor: {
      mockUserId: cfg.supervisorId,
      prefundWei: cfg.prefunds.supervisor,
      ...ROLE_META.supervisor,
    },
  }
}

interface RoleState {
  session: SignInResponse | null
  wallet: EthersWallet | null
  balance: bigint | null
  usdcBalance: bigint | null
  signing: boolean
  error: string | null
}

interface TxEntry {
  id: string
  label: string
  status: 'pending' | 'success' | 'error'
  hash?: string
  error?: string
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
  const whole = wei / 1_000_000_000_000_000_000n
  const frac = wei % 1_000_000_000_000_000_000n
  const fracStr = frac.toString().padStart(18, '0').slice(0, 4)
  return `${whole}.${fracStr} ETH`
}

function fmtUsdc(micro: bigint | null): string {
  if (micro == null) return '—'
  const whole = micro / 1_000_000n
  const frac = micro % 1_000_000n
  const fracStr = frac.toString().padStart(6, '0').slice(0, 2)
  return `${whole}.${fracStr} USDC`
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
  const rpc = useMemo(() => new JsonRpcProvider(cfg.rpcUrl), [cfg.rpcUrl])

  // Configured = enough info to actually fire txs. Receiver is always
  // needed. Escrow is needed for the pre-deployed sample; factory is needed
  // for the "Create Escrow" action. At least one must be present.
  const missingAdmin = !cfg.adminPrivateKey
  const missingAddrs = !cfg.receiver || (!cfg.escrow && !cfg.factoryAddress)
  const configured = !missingAddrs && !missingAdmin

  const [roles, setRoles] = useState<Record<Role, RoleState>>({
    recruiter: emptyRoleState(),
    funder: emptyRoleState(),
    worker: emptyRoleState(),
    supervisor: emptyRoleState(),
  })
  const [txs, setTxs] = useState<TxEntry[]>([])
  const [escrowAddr, setEscrowAddr] = useState<string>(cfg.escrow)
  const [escrowUsdcBalance, setEscrowUsdcBalance] = useState<bigint | null>(null)
  // Offer's kill fee in bps. Range 5%-25% (enforced on-chain); 10% default.
  // Set on the escrow at creation so workers can choose by protection level.
  const [killFeeBps, setKillFeeBps] = useState<number>(1000)
  // The active escrow's actual on-chain kill fee. May differ from the selector
  // (which only applies to escrows created here). Drives the refund preview.
  const [escrowKillFeeBps, setEscrowKillFeeBps] = useState<number | null>(null)
  // Timing windows (seconds), selectable per offer at creation.
  const [checkInTimeout, setCheckInTimeout] = useState<number>(3600)  // 1h
  const [checkOutTimeout, setCheckOutTimeout] = useState<number>(120) // 2m (demo)
  // Dispute window (seconds); worker can self-claim if the arbiter stays silent.
  const [disputeWindow, setDisputeWindow] = useState<number>(120) // 2m (demo)

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
      supervisor: emptyRoleState(),
    })
    setTxs([])
    setEscrowAddr(cfg.escrow)
    setEscrowUsdcBalance(null)
  }, [chain, cfg.escrow])

  // Live balance refresher.
  //
  // Two paths feed it:
  //   1. A 4-second `setInterval` safety net — picks up changes caused by
  //      txs we *didn't* initiate from this tab (e.g. the worker's balance
  //      bumping when another role calls `release`).
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
    // Resolve USDC address from the escrow contract once per refresh
    let usdcAddr: string | null = null
    if (escrowAddr) {
      try {
        const escrowRo = new EthContract(escrowAddr, ['function USDC() view returns (address)'], rpc)
        usdcAddr = await escrowRo.USDC()
      } catch {
        /* escrow not deployed yet, skip USDC */
      }
    }
    const erc20Abi = ['function balanceOf(address) view returns (uint256)']
    await Promise.all(
      (Object.keys(current) as Role[]).map(async (role) => {
        const addr = current[role].session?.accountAddress
        if (!addr) return
        try {
          const bal = await rpc.getBalance(addr)
          const usdcBal = usdcAddr
            ? await new EthContract(usdcAddr, erc20Abi, rpc).balanceOf(addr)
            : null
          updateRole(role, { balance: bal, usdcBalance: usdcBal })
        } catch {
          /* node not reachable, swallow */
        }
      }),
    )
    // Also refresh escrow contract's USDC balance
    if (usdcAddr && escrowAddr) {
      try {
        const escBal = await new EthContract(usdcAddr, erc20Abi, rpc).balanceOf(escrowAddr)
        setEscrowUsdcBalance(escBal)
      } catch {
        /* swallow */
      }
    }
  }, [rpc, updateRole, escrowAddr])

  useEffect(() => {
    void refreshBalances()
    const t = setInterval(() => void refreshBalances(), 4000)
    return () => clearInterval(t)
  }, [refreshBalances])

  // Read the active escrow's real killFeeBps whenever the target escrow changes,
  // so the refund preview matches the on-chain offer (the selector above only
  // sets the fee for escrows you create from this tab).
  useEffect(() => {
    if (!escrowAddr) {
      setEscrowKillFeeBps(null)
      return
    }
    let cancelled = false
    const ro = new EthContract(
      escrowAddr,
      ['function policy() view returns (tuple(address funder, address recruiter, bytes32 workerNullifier, uint32 checkInTimeout, uint32 checkOutTimeout, address witness, address arbiter, uint16 killFeeBps, uint256 amount, bytes32 termsHash, uint64 jobStartTime, uint32 disputeWindow))'],
      rpc,
    )
    ro.policy()
      .then((p) => { if (!cancelled) setEscrowKillFeeBps(Number(p.killFeeBps)) })
      .catch(() => { if (!cancelled) setEscrowKillFeeBps(null) })
    return () => { cancelled = true }
  }, [escrowAddr, rpc])

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
        contracts: { nullifierRegistry: cfg.receiver, escrow: cfg.escrow },
        mockUserId: meta.mockUserId,
        adminPrivateKey: cfg.adminPrivateKey,
        prefundWei: meta.prefundWei,
      })
      const tx = newTx(setTxs, `${meta.emoji} sign-in: ${meta.label}`, cfg.explorerBase)
      try {
        const session = await provider.signIn({})
        const pk = await deriveDeterministicPk(meta.mockUserId)
        const wallet = new EthersWallet(pk, rpc)
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
  // Realistic spot-escrow hiring flow (witness mode):
  //   0. HR (recruiter) creates a new spot escrow via the EscrowFactory (CREATE2)
  //   1. Finance (funder) approves USDC spending for the escrow contract
  //   2. Finance (funder) funds the escrow (locks USDC)
  //   3. HR (recruiter) awards the selected worker after candidate review
  //      (after funding, before check-in — in real life these are ~simultaneous)
  //   4. HR (recruiter) assigns the on-site supervisor as witness via setWitness
  //   5. Supervisor (witness) checks in the worker — attests they showed up
  //   6. Supervisor (witness) checks out the worker — attests work done → auto-release
  //   7. Exit paths (worker-protective):
  //      - refund: Finance cancels before check-in → awarded worker gets a kill
  //        fee (killFeeBps), remainder back to Finance
  //      - reclaimNoShow: worker never checked in by deadline → Finance reclaims all
  //      - claimAfterCheckoutTimeout: worker checked in but the company witness
  //        never checked out → funds release to the WORKER
  //      - raiseDispute / resolveDispute: either party escalates to the neutral
  //        arbiter, who splits the funds
  //
  // HR is the initial witness at deploy time (fallback for remote jobs).
  // HR can reassign to an on-site supervisor via setWitness at any time.
  //
  // Step 2 (fund) requires the USDC allowance from step 1. Step 3 (award)
  // requires the escrow to be funded and must precede check-in, so funds can
  // never go active without a selected worker.
  const escrowFor = useCallback(
    (wallet: EthersWallet) =>
      new CofferdamSpotEscrowClient({ address: escrowAddr, signer: wallet }),
    [escrowAddr],
  )

  // Neutral arbiter wallet (platform / Cofferdam). In the demo this is the
  // admin key — the same wallet set as `arbiter` in the deployed escrow policy
  // — so it can call resolveDispute.
  const arbiterWallet = useMemo(
    () => (cfg.adminPrivateKey ? new EthersWallet(cfg.adminPrivateKey, rpc) : null),
    [cfg.adminPrivateKey, rpc],
  )

  // ── Factory: create a new spot escrow via CREATE2 ─────────────────────
  //
  // HR (recruiter) creates the escrow through the EscrowFactory. The factory
  // enforces access control — the deployer is auto-authorized. The salt is
  // derived from the recruiter + worker IDs so the address is deterministic
  // and reproducible. After creation, escrowAddr is updated so all subsequent
  // actions (fund, setWitness, checkIn, checkOut) target the new escrow.
  const createEscrow = useCallback(async () => {
    const wallet = roles.recruiter.wallet
    if (!wallet || !cfg.factoryAddress) return
    const factory = new CofferdamEscrowFactoryClient({
      address: cfg.factoryAddress,
      signer: wallet,
    })
    const funderAddr = roles.funder.session?.accountAddress
    const workerAddr = roles.worker.session?.accountAddress
    const recruiterAddr = roles.recruiter.session?.accountAddress
    if (!funderAddr || !workerAddr || !recruiterAddr) return

    // Deterministic salt from role IDs + timestamp — hashed to proper bytes32
    const salt = ethersId(`${cfg.recruiterId}:${cfg.workerId}:${Date.now()}`)

    const policy = {
      funder: funderAddr,
      recruiter: recruiterAddr,
      workerNullifier: hexlify(randomBytes(32)) as `0x${string}`,
      checkInTimeout,
      checkOutTimeout,
      witness: recruiterAddr, // HR is initial witness (fallback for remote)
      arbiter: arbiterWallet?.address ?? recruiterAddr, // neutral platform resolver
      killFeeBps, // funder-cancellation fee (5%-25%), default 10% — set per offer
      amount: cfg.amountUsdc, // agreed pay — fund() must deposit exactly this
      termsHash: ethersId('cofferdam-spot-demo-terms-v1'), // pointer to off-chain agreed terms
      jobStartTime: 0, // effective at creation (no scheduled start)
      disputeWindow, // worker can claim if the arbiter stays silent
    }

    const tx = newTx(
      setTxs,
      `🏭 createSpotEscrow (via factory, CREATE2)`,
      cfg.explorerBase,
    )
    try {
      const result = await factory.createSpotEscrow(policy, salt, {
        onSent: (h) => tx.setHash(h),
      })
      setEscrowAddr(result.escrowAddress)
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.recruiter.wallet, roles.funder.session?.accountAddress, roles.worker.session?.accountAddress, roles.recruiter.session?.accountAddress, arbiterWallet, killFeeBps, checkInTimeout, checkOutTimeout, disputeWindow, cfg.amountUsdc, cfg.factoryAddress, cfg.recruiterId, cfg.workerId, cfg.explorerBase, refreshBalances])

  const approveUSDC = useCallback(async () => {
    const wallet = roles.funder.wallet
    if (!wallet) return
    const escrow = escrowFor(wallet)
    const tx = newTx(
      setTxs,
      `✅ approveUSDC (${fmtUsdc(cfg.amountUsdc)})`,
      cfg.explorerBase,
    )
    try {
      await escrow.approveUSDC(cfg.amountUsdc, {
        onSent: (h) => tx.setHash(h),
      })
      tx.success()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.funder.wallet, escrowFor, cfg.amountUsdc, cfg.explorerBase])

  const awardWorker = useCallback(async () => {
    const wallet = roles.recruiter.wallet
    const workerAddr = roles.worker.session?.accountAddress
    if (!wallet || !workerAddr) return
    const escrow = escrowFor(wallet)
    const tx = newTx(
      setTxs,
      `🎯 awardWorker (${shortAddr(workerAddr)}) — HR selects candidate`,
      cfg.explorerBase,
    )
    try {
      await escrow.awardWorker(workerAddr, {
        onSent: (h) => tx.setHash(h),
      })
      tx.success()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.recruiter.wallet, roles.worker.session?.accountAddress, escrowFor, cfg.explorerBase])

  const fund = useCallback(async () => {
    const wallet = roles.funder.wallet
    if (!wallet) return
    const escrow = escrowFor(wallet)
    const tx = newTx(
      setTxs,
      `💸 fund (${fmtUsdc(cfg.amountUsdc)})`,
      cfg.explorerBase,
    )
    try {
      await escrow.fund(cfg.amountUsdc, {
        onSent: (h) => tx.setHash(h),
      })
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.funder.wallet, escrowFor, cfg.amountUsdc, cfg.explorerBase, refreshBalances])

  const setWitness = useCallback(async () => {
    const wallet = roles.recruiter.wallet
    const supervisorAddr = roles.supervisor.session?.accountAddress
    if (!wallet || !supervisorAddr) return
    const escrow = escrowFor(wallet)
    const tx = newTx(
      setTxs,
      `🔧 setWitness (${shortAddr(supervisorAddr)}) — HR → Supervisor`,
      cfg.explorerBase,
    )
    try {
      await escrow.setWitness(supervisorAddr, { onSent: (h) => tx.setHash(h) })
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.recruiter.wallet, roles.supervisor.session?.accountAddress, escrowFor, cfg.explorerBase, refreshBalances])

  const checkIn = useCallback(async () => {
    const wallet = roles.supervisor.wallet ?? roles.recruiter.wallet
    const workerAddr = roles.worker.session?.accountAddress
    if (!wallet || !workerAddr) return
    const escrow = escrowFor(wallet)
    const witnessLabel = wallet === roles.recruiter.wallet ? 'HR (fallback)' : 'Supervisor'
    const tx = newTx(
      setTxs,
      `🕒 checkIn (${shortAddr(workerAddr)}) — witness: ${witnessLabel}`,
      cfg.explorerBase,
    )
    try {
      await escrow.checkIn(workerAddr, { onSent: (h) => tx.setHash(h) })
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.supervisor.wallet, roles.recruiter.wallet, roles.worker.session?.accountAddress, escrowFor, cfg.explorerBase, refreshBalances])

  const checkOut = useCallback(async () => {
    const wallet = roles.supervisor.wallet ?? roles.recruiter.wallet
    if (!wallet) return
    const escrow = escrowFor(wallet)
    const witnessLabel = wallet === roles.recruiter.wallet ? 'HR (fallback)' : 'Supervisor'
    const tx = newTx(setTxs, `✅ checkOut — witness: ${witnessLabel} (auto-releases USDC)`, cfg.explorerBase)
    try {
      await escrow.checkOut({ onSent: (h) => tx.setHash(h) })
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.supervisor.wallet, roles.recruiter.wallet, escrowFor, cfg.explorerBase, refreshBalances])

  // Refund preview uses the active escrow's real fee; fall back to the selector
  // (the level a newly created offer would use) until the on-chain read lands.
  const activeKillFeeBps = escrowKillFeeBps ?? killFeeBps
  const killFeeUsdc = (cfg.amountUsdc * BigInt(activeKillFeeBps)) / 10_000n

  const refund = useCallback(async () => {
    const wallet = roles.funder.wallet
    if (!wallet) return
    const escrow = escrowFor(wallet)
    const tx = newTx(setTxs, `↩️ refund (kill fee ${fmtUsdc(killFeeUsdc)} → worker, rest → funder)`, cfg.explorerBase)
    try {
      await escrow.refund({ onSent: (h) => tx.setHash(h) })
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.funder.wallet, escrowFor, killFeeUsdc, cfg.explorerBase, refreshBalances])

  const reclaimNoShow = useCallback(async () => {
    const wallet = roles.funder.wallet
    if (!wallet) return
    const escrow = escrowFor(wallet)
    const tx = newTx(setTxs, `🚫 reclaimNoShow (${fmtUsdc(cfg.amountUsdc)} → funder, worker no-show)`, cfg.explorerBase)
    try {
      await escrow.reclaimNoShow({ onSent: (h) => tx.setHash(h) })
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.funder.wallet, escrowFor, cfg.amountUsdc, cfg.explorerBase, refreshBalances])

  const claimTimeout = useCallback(async () => {
    const wallet = roles.worker.wallet ?? roles.funder.wallet
    if (!wallet) return
    const escrow = escrowFor(wallet)
    const tx = newTx(setTxs, `⏰ claimAfterCheckoutTimeout (${fmtUsdc(cfg.amountUsdc)} → worker)`, cfg.explorerBase)
    try {
      await escrow.claimAfterCheckoutTimeout({ onSent: (h) => tx.setHash(h) })
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.worker.wallet, roles.funder.wallet, escrowFor, cfg.amountUsdc, cfg.explorerBase, refreshBalances])

  const raiseDispute = useCallback(async () => {
    const wallet = roles.worker.wallet
    if (!wallet) return
    const escrow = escrowFor(wallet)
    const reason = ethersId(`dispute:${Date.now()}`)
    const tx = newTx(setTxs, `⚖️ raiseDispute (worker escalates to arbiter)`, cfg.explorerBase)
    try {
      await escrow.raiseDispute(reason, { onSent: (h) => tx.setHash(h) })
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.worker.wallet, escrowFor, cfg.explorerBase, refreshBalances])

  const resolveDispute = useCallback(async () => {
    if (!arbiterWallet) return
    const escrow = escrowFor(arbiterWallet)
    const workerAmount = cfg.amountUsdc / 2n
    const tx = newTx(setTxs, `🧑‍⚖️ resolveDispute (arbiter: ${fmtUsdc(workerAmount)} → worker, rest → funder)`, cfg.explorerBase)
    try {
      await escrow.resolveDispute(workerAmount, { onSent: (h) => tx.setHash(h) })
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [arbiterWallet, escrowFor, cfg.amountUsdc, cfg.explorerBase, refreshBalances])

  const claimDisputeTimeout = useCallback(async () => {
    const wallet = roles.worker.wallet ?? roles.funder.wallet
    if (!wallet) return
    const escrow = escrowFor(wallet)
    const tx = newTx(setTxs, `⏰ claimAfterDisputeTimeout (${fmtUsdc(cfg.amountUsdc)} → worker, arbiter silent)`, cfg.explorerBase)
    try {
      await escrow.claimAfterDisputeTimeout({ onSent: (h) => tx.setHash(h) })
      tx.success()
      void refreshBalances()
    } catch (err) {
      tx.error(errMsg(err))
    }
  }, [roles.worker.wallet, roles.funder.wallet, escrowFor, cfg.amountUsdc, cfg.explorerBase, refreshBalances])

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
            Run <code>yarn deploy:local</code> in the base-contracts repo
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
            <code>CofferdamReceiver</code> — it signs <code>bindNullifier</code>{' '}
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
      ? `Four roles, one Base Sepolia deployment. Finance funds, HR assigns supervisor as witness, supervisor checks worker in/out — checkout auto-releases USDC. Demo amounts scaled 100× smaller (${fmtUsdc(cfg.amountUsdc)} per job).`
      : 'Four roles, one base-anvil node. Finance funds the escrow, HR assigns an on-site supervisor as witness, supervisor checks worker in and out — checkout auto-releases USDC to the worker. HR can reassign the supervisor at any time (rotation fallback). Watch the activity log + your node terminal side-by-side.'

  return (
    <main className="container container-wide">
      <h1>
        {title}
        {chain === 'testnet' && (
          <span className="chain-badge" title="Base Sepolia (chainId 84532)">
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
          <strong>Factory:</strong>{' '}
          {cfg.explorerBase ? (
            <a
              href={`${cfg.explorerBase}/address/${cfg.factoryAddress}`}
              target="_blank"
              rel="noreferrer"
            >
              <code>{shortAddr(cfg.factoryAddress)}</code>
            </a>
          ) : (
            <code>{shortAddr(cfg.factoryAddress)}</code>
          )}
          {' · '}
          <strong>Escrow:</strong>{' '}
          {cfg.explorerBase ? (
            <a
              href={`${cfg.explorerBase}/address/${escrowAddr}`}
              target="_blank"
              rel="noreferrer"
            >
              <code>{shortAddr(escrowAddr)}</code>
            </a>
          ) : (
            <code>{shortAddr(escrowAddr)}</code>
          )}
          {' · '}
          <strong>Escrow USDC:</strong>{' '}
          <code>{fmtUsdc(escrowUsdcBalance)}</code>
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

      <h2 className="section-h">Offer terms</h2>
      <div className="funder-picker">
        <span className="funder-label">
          Kill fee — paid to the worker if the company cancels before check-in (range 5–25%)
        </span>
        <div className="funder-candidates">
          {[500, 1000, 1500, 2500].map((bps) => (
            <button
              key={bps}
              className={`funder-chip ${killFeeBps === bps ? 'funder-chip-on' : ''}`}
              onClick={() => setKillFeeBps(bps)}
              title={`Set this offer's kill fee to ${bps / 100}%`}
            >
              {bps / 100}%{bps === 1000 ? ' · default' : ''}
            </button>
          ))}
        </div>
        <p className="funder-hint">
          Set on the offer at creation (applies to escrows you create here). Workers pick offers
          by protection level, so companies that commit to fairer terms attract more reliable
          workers and get more fulfilments — competition that lifts the whole market. A new offer
          at this level pays{' '}
          <strong>{fmtUsdc((cfg.amountUsdc * BigInt(killFeeBps)) / 10_000n)}</strong> on{' '}
          {fmtUsdc(cfg.amountUsdc)} if cancelled before check-in.
          {escrowKillFeeBps !== null && (
            <>
              {' · '}Active escrow on-chain: <strong>{escrowKillFeeBps / 100}%</strong>{' '}
              ({fmtUsdc((cfg.amountUsdc * BigInt(escrowKillFeeBps)) / 10_000n)}).
            </>
          )}
        </p>
        <span className="funder-label">
          Check-in window — how long the worker has to check in before Finance can reclaim a no-show (Rule C)
        </span>
        <div className="funder-candidates">
          {[
            { s: 3600, label: '1h' },
            { s: 21600, label: '6h' },
            { s: 86400, label: '24h' },
            { s: 259200, label: '3d' },
          ].map(({ s, label }) => (
            <button
              key={s}
              className={`funder-chip ${checkInTimeout === s ? 'funder-chip-on' : ''}`}
              onClick={() => setCheckInTimeout(s)}
              title={`Worker must check in within ${label} of creation`}
            >
              {label}{s === 3600 ? ' · default' : ''}
            </button>
          ))}
        </div>
        <span className="funder-label">
          Check-out timeout — after this, a checked-in worker can self-claim if the witness never checks out (Rule D)
        </span>
        <div className="funder-candidates">
          {[
            { s: 120, label: '2m (demo)' },
            { s: 3600, label: '1h' },
            { s: 28800, label: '8h' },
            { s: 86400, label: '24h' },
          ].map(({ s, label }) => (
            <button
              key={s}
              className={`funder-chip ${checkOutTimeout === s ? 'funder-chip-on' : ''}`}
              onClick={() => setCheckOutTimeout(s)}
              title={`Worker can self-claim ${label} after check-in if not checked out`}
            >
              {label}{s === 120 ? ' · default' : ''}
            </button>
          ))}
        </div>
        <span className="funder-label">
          Dispute window — after this, a worker in a dispute can self-claim if the arbiter never resolves (Rule G)
        </span>
        <div className="funder-candidates">
          {[
            { s: 0, label: 'off' },
            { s: 120, label: '2m (demo)' },
            { s: 86400, label: '24h' },
            { s: 604800, label: '7d' },
          ].map(({ s, label }) => (
            <button
              key={s}
              className={`funder-chip ${disputeWindow === s ? 'funder-chip-on' : ''}`}
              onClick={() => setDisputeWindow(s)}
              title={s === 0 ? 'No dispute deadline (arbiter must resolve)' : `Worker can self-claim ${label} after raising a dispute if unresolved`}
            >
              {label}{s === 120 ? ' · default' : ''}
            </button>
          ))}
        </div>
      </div>

      <h2 className="section-h">Escrow lifecycle</h2>
      <div className="flow">
        {/* Phase 1 — Created: setup & funding */}
        <div className="flow-phase">
          <div className="flow-phase-head">
            <span className="flow-state">Created</span> Setup &amp; funding
          </div>
          <div className="actions">
            <button
              className="action"
              onClick={createEscrow}
              disabled={!roles.recruiter.wallet || !cfg.factoryAddress || !roles.funder.session || !roles.worker.session}
              title="HR creates a new spot escrow via the EscrowFactory (CREATE2). Requires all roles signed in."
            >
              0️⃣ Create escrow (factory, CREATE2)
            </button>
            <button
              className="action"
              onClick={approveUSDC}
              disabled={!roles.funder.wallet}
              title="Finance approves USDC spending for the escrow contract. Separate from funding so the chain can sync."
            >
              1️⃣ Approve USDC ({fmtUsdc(cfg.amountUsdc)})
            </button>
            <button
              className="action"
              onClick={fund}
              disabled={!roles.funder.wallet}
              title="Finance funds the escrow (locks USDC). Requires USDC approval. The worker is awarded right after funding."
            >
              2️⃣ Fund escrow ({fmtUsdc(cfg.amountUsdc)})
            </button>
          </div>
        </div>

        {/* Phase 2 — Funded: award & staffing */}
        <div className="flow-phase">
          <div className="flow-phase-head">
            <span className="flow-state">Funded</span> Award &amp; staffing
          </div>
          <div className="actions">
            <button
              className="action"
              onClick={awardWorker}
              disabled={!roles.recruiter.wallet || !roles.worker.session}
              title="HR awards the selected worker after candidate review. Done after funding, before check-in."
            >
              3️⃣ Award worker (HR → select candidate)
            </button>
            <button
              className="action"
              onClick={setWitness}
              disabled={!roles.recruiter.wallet || !roles.supervisor.session}
              title="HR assigns the on-site supervisor as witness. Supervisor can then check in/out the worker."
            >
              4️⃣ Assign supervisor (HR → witness)
            </button>
          </div>
          <div className="flow-branch">
            <div className="flow-branch-head">Exit paths — before check-in</div>
            <div className="actions">
              <button
                className="action action-cancel"
                onClick={refund}
                disabled={!roles.funder.wallet}
                title="Finance cancels before check-in. The awarded worker is paid the offer's kill fee (5–25%, default 10%) for declining other offers; remainder returns to Finance."
              >
                ↩️ Refund + kill fee (worker compensated)
              </button>
              <button
                className="action action-cancel"
                onClick={reclaimNoShow}
                disabled={!roles.funder.wallet}
                title="Worker never checked in by the deadline (no-show). Finance reclaims the full amount, no kill fee."
              >
                🚫 Reclaim no-show (full → Finance)
              </button>
            </div>
          </div>
        </div>

        {/* Phase 3 — Active: on-site work */}
        <div className="flow-phase">
          <div className="flow-phase-head">
            <span className="flow-state">Active</span> On-site work
          </div>
          <div className="actions">
            <button
              className="action"
              onClick={checkIn}
              disabled={(!roles.supervisor.wallet && !roles.recruiter.wallet) || !roles.worker.session}
              title="Witness (supervisor, or HR as fallback) checks in the worker — attests they showed up."
            >
              5️⃣ Check in worker (witness)
            </button>
            <button
              className="action action-settle"
              onClick={checkOut}
              disabled={!roles.supervisor.wallet && !roles.recruiter.wallet}
              title="Witness (supervisor, or HR as fallback) checks out the worker — attests work done. Auto-releases USDC to worker."
            >
              6️⃣ Check out + auto-release (witness)
            </button>
          </div>
          <div className="flow-branch">
            <div className="flow-branch-head">Exit path — after check-in</div>
            <div className="actions">
              <button
                className="action action-settle"
                onClick={claimTimeout}
                disabled={!roles.worker.wallet}
                title="Worker checked in but the company witness never checked them out. After the checkout timeout the worker claims the funds — inaction risk sits with the company."
              >
                ⏰ Worker claim (witness no-checkout)
              </button>
            </div>
          </div>
        </div>

        {/* Phase 4 — Disputed: arbitration (reachable from Funded or Active) */}
        <div className="flow-phase">
          <div className="flow-phase-head">
            <span className="flow-state">Disputed</span> Disputes &amp; arbitration
          </div>
          <div className="actions">
            <button
              className="action action-cancel"
              onClick={raiseDispute}
              disabled={!roles.worker.wallet}
              title="Worker (or any party) escalates to the neutral arbiter — e.g. checked in but the witness won't check out, or disagreement on completion. Moves escrow to Disputed."
            >
              ⚖️ Raise dispute (worker / funder)
            </button>
            <button
              className="action action-settle"
              onClick={resolveDispute}
              disabled={!arbiterWallet}
              title="Neutral arbiter resolves the dispute, splitting funds between worker and funder based on evidence (demo: 50/50)."
            >
              🧑‍⚖️ Resolve dispute (arbiter)
            </button>
            <button
              className="action action-settle"
              onClick={claimDisputeTimeout}
              disabled={!roles.worker.wallet}
              title="If the arbiter never resolves within the dispute window, the worker claims the full amount — arbiter-silence risk sits with the system, not the worker."
            >
              ⏰ Worker claim (arbiter silent)
            </button>
          </div>
        </div>
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
            <span>USDC</span>
            <code>{fmtUsdc(state.usdcBalance)}</code>
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
  return { session: null, wallet: null, balance: null, usdcBalance: null, signing: false, error: null }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

interface TxHandle {
  setHash(hash: string): void
  success(): void
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
    error: (msg) => patch({ status: 'error', error: msg }),
  }
}

