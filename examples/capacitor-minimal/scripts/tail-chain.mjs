#!/usr/bin/env node
// Stream + decode local-chain activity over JSON-RPC.
//
// Polls `eth_blockNumber` against the configured anvil-zksync RPC, fetches
// each new block with its txs, and prints one line per tx with:
//   - the function name + decoded args (if the call target is the Receiver
//     or the Escrow)
//   - every emitted event from those two contracts
//
// Why a tail script and not just turn up anvil-zksync's verbosity? Because
// the latter spams every internal system-contract call and is impossible
// to scan visually during a click-through demo. This script is "what
// happened on YOUR contracts, in chronological order, in one line per tx".
//
// Run:
//   yarn workspace @cofferdam/example-capacitor-minimal tail
// or:
//   node scripts/tail-chain.mjs
//
// Reads `.env.local` automatically (same file the Vite demo uses). Override
// any value via process env (e.g. `RPC=http://… node scripts/tail-chain.mjs`).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Interface, formatEther } from 'ethers'
// zksync-ethers' Provider handles ZKSync's EIP-712 (type 0x71/113) tx
// envelope, which stock ethers JsonRpcProvider chokes on. We're already
// depending on it for the demo so it costs nothing here.
import { Provider as ZkProvider } from 'zksync-ethers'

// ── Env loading ────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '..', '.env.local')
const env = { ...process.env }
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const [, k, raw] = m
    if (env[k] !== undefined) continue
    env[k] = raw.replace(/^['"]|['"]$/g, '')
  }
}

// Mode-aware env resolution. We honour VITE_COFFERDAM_NETWORK so the same
// `yarn tail` works for whichever mode the demo is currently in:
//
//   - mock OR local-chain (default) → reads VITE_LOCAL_* with anvil defaults.
//   - sepolia-testnet              → reads VITE_TESTNET_* with the deployed
//                                     Sepolia addresses + public Sepolia RPC
//                                     as defaults (matches the React demo's
//                                     buildConfig() in LocalChainDemo.tsx).
//
// Hard env overrides (RPC=, RECEIVER=, ESCROW=) still win regardless of
// mode — useful for ad-hoc tail against a third deploy without touching
// .env.local.
const NETWORK_MODE = env.VITE_COFFERDAM_NETWORK || 'mock'
const IS_TESTNET = NETWORK_MODE === 'sepolia-testnet'

const RPC =
  env.RPC ||
  (IS_TESTNET
    ? env.VITE_TESTNET_RPC_URL || 'https://sepolia.era.zksync.dev'
    : env.VITE_LOCAL_RPC_URL || 'http://127.0.0.1:8011')

const RECEIVER =
  env.RECEIVER ||
  (IS_TESTNET
    ? env.VITE_TESTNET_RECEIVER_ADDRESS ||
      '0x6b4D8580f72C1D3Eb9825aD6EE56c67ED0F1B9Bb'
    : env.VITE_LOCAL_RECEIVER_ADDRESS)

const ESCROW =
  env.ESCROW ||
  (IS_TESTNET
    ? env.VITE_TESTNET_ESCROW_ADDRESS ||
      '0x2F22FE817dAA3Bff101f888C94F3ce0814880535'
    : env.VITE_LOCAL_ESCROW_ADDRESS)

if (!RECEIVER || !ESCROW) {
  const ns = IS_TESTNET ? 'VITE_TESTNET' : 'VITE_LOCAL'
  console.error(
    `Missing RECEIVER / ESCROW addresses. Either set them in .env.local\n` +
      `(${ns}_RECEIVER_ADDRESS / ${ns}_ESCROW_ADDRESS) or pass via\n` +
      `env: RECEIVER=0x… ESCROW=0x… node scripts/tail-chain.mjs`,
  )
  process.exit(1)
}

// ── ABIs ───────────────────────────────────────────────────────────────────
// Minimal fragments — only what the demo + bind flow actually invoke. Add
// more if you wire up new contract methods in the demo.
const RECEIVER_ABI = [
  'function bindNullifier(address account, bytes32 nullifier)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
  'event NullifierBound(address indexed account, bytes32 indexed nullifier)',
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
]
const ESCROW_ABI = [
  'function postContract(bytes32 termsHash) payable returns (uint256)',
  'function postContractIntent(bytes32 termsHash, uint256 amount, address designatedFunder) returns (uint256)',
  'function fundContract(uint256 contractId) payable',
  'function awardContract(uint256 contractId, address workerAccount)',
  'function checkIn(uint256 contractId)',
  'function checkOut(uint256 contractId)',
  'function settle(uint256 contractId)',
  'function cancel(uint256 contractId)',
  'function cancelDraft(uint256 contractId)',
  'function dispute(uint256 contractId)',
  'function resolveDispute(uint256 contractId, uint8 resolution)',
  'event ContractDrafted(uint256 indexed contractId, address indexed recruiter, address indexed designatedFunder, uint256 amount, bytes32 termsHash)',
  'event ContractFunded(uint256 indexed contractId, address indexed funder, uint256 amount)',
  'event ContractPosted(uint256 indexed contractId, address indexed recruiter, uint256 amount, bytes32 termsHash)',
  'event ContractAwarded(uint256 indexed contractId, address indexed worker)',
  'event CheckedIn(uint256 indexed contractId, address indexed worker, uint256 at)',
  'event CheckedOut(uint256 indexed contractId, address indexed worker, uint256 at)',
  'event ContractSettled(uint256 indexed contractId, address indexed worker, uint256 amount)',
  'event ContractCancelled(uint256 indexed contractId)',
  'event ContractDisputed(uint256 indexed contractId, address indexed disputer)',
]
const receiverIface = new Interface(RECEIVER_ABI)
const escrowIface   = new Interface(ESCROW_ABI)

// Address → { label, iface } for decoding by call target / log emitter.
const KNOWN = new Map([
  [RECEIVER.toLowerCase(), { label: 'Receiver', iface: receiverIface }],
  [ESCROW.toLowerCase(),   { label: 'Escrow',   iface: escrowIface }],
])

// ── ANSI helpers (no deps; works on macOS Terminal / iTerm) ────────────────
const c = {
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  magenta:(s) => `\x1b[35m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
}

function short(addr) {
  if (!addr) return '—'
  const s = addr.toString()
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s
}
function fmtArg(a) {
  if (typeof a === 'bigint') {
    // Heuristic: anything > 0.0001 ETH-shaped wei → format as ETH.
    if (a >= 10n ** 14n) return `${formatEther(a)} ETH`
    return a.toString()
  }
  if (typeof a === 'string' && a.startsWith('0x') && a.length === 42) return short(a)
  if (typeof a === 'string' && a.startsWith('0x') && a.length === 66) return short(a)
  if (Array.isArray(a)) return `[${a.map(fmtArg).join(', ')}]`
  return String(a)
}
function fmtArgs(fragment, args) {
  return args
    .map((a, i) => {
      const name = fragment.inputs[i]?.name
      return name ? `${name}=${fmtArg(a)}` : fmtArg(a)
    })
    .join(', ')
}

// ── CLI flags (no deps) ────────────────────────────────────────────────────
// `--backfill=N`  → print history from `head-N` to head before tailing
// `--all`         → don't filter; print every tx, not just Receiver/Escrow
const argv = process.argv.slice(2)
const flagVal = (name, fallback) => {
  for (const a of argv) {
    if (a === `--${name}`) return true
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3)
  }
  return fallback
}
const BACKFILL = Number(flagVal('backfill', env.BACKFILL ?? '50'))
const PRINT_ALL = !!flagVal('all', false)

// ── Main loop ──────────────────────────────────────────────────────────────
const provider = new ZkProvider(RPC)

const net = await provider.getNetwork().catch(() => null)
if (!net) {
  console.error(c.red(`Could not reach RPC at ${RPC}. Is anvil-zksync running?`))
  process.exit(1)
}

console.log(c.bold(`tail-chain ▸ ${RPC} (chain ${net.chainId})`))
console.log(c.dim(`Receiver: ${RECEIVER}`))
console.log(c.dim(`Escrow:   ${ESCROW}`))
console.log(c.dim(`Mode: ${PRINT_ALL ? 'ALL txs' : 'Receiver/Escrow only'}` +
  ` · backfill last ${BACKFILL} block(s) · Ctrl-C to stop\n`))

const head0 = await provider.getBlockNumber()

// Backfill first so the user sees that "head=4420" isn't empty — anything
// interesting that happened recently is replayed immediately.
const from = Math.max(0, head0 - BACKFILL)
if (BACKFILL > 0 && from < head0) {
  console.log(c.dim(`── backfilling blocks ${from + 1}..${head0} ─────`))
  let printed = 0
  for (let n = from + 1; n <= head0; n++) {
    printed += await processBlock(n)
  }
  if (printed === 0) {
    console.log(c.dim(
      `(no Receiver/Escrow activity in the last ${BACKFILL} blocks; ` +
      `re-run with --all to see every tx)`,
    ))
  }
  console.log(c.dim(`── backfill done · now tailing from block ${head0 + 1} ─────\n`))
}

let cursor = head0
let lastHeartbeat = Date.now()
const POLL_MS = 800
const HEARTBEAT_MS = 10_000

while (true) {
  let head
  try {
    head = await provider.getBlockNumber()
  } catch (err) {
    console.error(c.red(`RPC error: ${err.message}`))
    await sleep(2000)
    continue
  }

  while (cursor < head) {
    cursor++
    await processBlock(cursor)
  }

  // Heartbeat: prove the script is alive even when no blocks land.
  // anvil-zksync only mines on tx receipt, so a chain head that doesn't
  // advance just means nobody's sent a tx — NOT that tail is broken.
  const now = Date.now()
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    const ts = new Date(now).toISOString().slice(11, 19)
    console.log(c.dim(`[${ts}] still at block ${cursor}, no new activity`))
    lastHeartbeat = now
  }

  await sleep(POLL_MS)
}

// ── Block processor ───────────────────────────────────────────────────────
//
// Implementation note: we use `provider.send('eth_getTransactionByHash', …)`
// instead of `provider.getTransaction(hash)`. The latter — at least in the
// version of `zksync-ethers` we depend on — incorrectly returns the
// RLP-encoded EIP-712 (type-0x71) envelope in the `.data` field for ZKSync
// transactions, so `Interface.parseTransaction()` chokes and we lose
// function-name decoding. The raw RPC response always carries the inner
// calldata under `input` (the geth-standard field name), which is what we
// want. Same reasoning for value/from/to — we read straight off the
// JSON-RPC payload to avoid any wrapper quirk.
async function processBlock(n) {
  // `false` here = we only want tx hashes, we'll fetch each tx with
  // `eth_getTransactionByHash` so we get the raw JSON-RPC payload.
  const blockHex = `0x${n.toString(16)}`
  let block
  try {
    block = await provider.send('eth_getBlockByNumber', [blockHex, false])
  } catch (err) {
    console.error(c.red(`eth_getBlockByNumber(${n}) failed: ${err.message}`))
    return 0
  }
  if (!block) return 0
  const txHashes = block.transactions ?? []
  if (txHashes.length === 0) return 0

  let printedCount = 0
  for (const txHash of txHashes) {
    const tx = await provider.send('eth_getTransactionByHash', [txHash]).catch(() => null)
    if (!tx) continue
    const to = (tx.to ?? '').toLowerCase()
    const known = KNOWN.get(to)
    if (!known && !PRINT_ALL) continue
    printedCount++

    const valueWei = tx.value ? BigInt(tx.value) : 0n
    const calldata = tx.input ?? '0x'
    const targetTag = known
      ? c.cyan(known.label)
      : c.dim(`EOA→${short(tx.to ?? '0x0')}`)

    let callDesc = ''
    if (known && calldata && calldata.length >= 10) {
      try {
        const parsed = known.iface.parseTransaction({ data: calldata, value: valueWei })
        if (parsed) {
          const args = fmtArgs(parsed.fragment, parsed.args)
          callDesc = ` ${c.bold(parsed.name)}(${args})`
        }
      } catch {/* unknown selector — fall through */}
    }
    if (!callDesc && valueWei > 0n) {
      callDesc = ` ${c.yellow(`value=${formatEther(valueWei)} ETH`)}`
    }
    if (!callDesc && calldata && calldata.length >= 10) {
      callDesc = ` ${c.dim(`selector=${calldata.slice(0, 10)}`)}`
    }

    console.log(
      `${c.dim(`block ${parseInt(block.number, 16)}`)} ${c.dim(short(tx.hash))} ` +
      `from ${c.magenta(short(tx.from))} → ${targetTag}${callDesc}`,
    )

    const receipt = await provider
      .send('eth_getTransactionReceipt', [tx.hash])
      .catch(() => null)
    if (!receipt) continue
    if (receipt.status && BigInt(receipt.status) === 0n) {
      console.log(`  ${c.red('↳ REVERTED')}`)
      continue
    }
    for (const log of receipt.logs ?? []) {
      const lk = KNOWN.get(log.address.toLowerCase())
      if (!lk) continue
      try {
        const ev = lk.iface.parseLog({ topics: [...log.topics], data: log.data })
        if (!ev) continue
        const args = fmtArgs(ev.fragment, ev.args)
        console.log(`  ${c.green(`↳ ${lk.label}.${ev.name}`)}(${args})`)
      } catch {/* unindexed event */}
    }
  }
  return printedCount
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
