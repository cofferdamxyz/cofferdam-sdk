// One-shot, headless verification of the web2-credential -> on-chain-account
// lane against Base Sepolia. Mirrors what Web2LoginDemo does in the UI:
//   login -> counterfactual address -> deploy -> (fund paymaster) ->
//   enroll first passkey (session-signed, fires the ratchet) ->
//   assert passkeyCount=1 / upgradeLocked / session authority deactivated ->
//   try the old web2 login again and assert it is locked out.
//
// Usage: node scripts/verify-web2-auth.mjs
// Reads addresses + the deployer/bundler key from .env.local.

import { readFileSync } from 'node:fs'
import { Contract, Interface, JsonRpcProvider, Wallet, formatEther } from 'ethers'
import { NativeAccountProvider } from '@cofferdam/sdk/native'
import { deriveSessionSigner, DeterministicPasskeySigner, encodePasskeyConfig } from '@cofferdam/sdk'

const ACCOUNT_IFACE = new Interface([
  'function enrollFirstPasskey(uint256 lowAuthorityId, address passkeyModule, bytes passkeyConfig)',
])
const EP_IFACE = new Interface([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
  'event PostOpRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
])

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const cfg = {
  scope: 'capacitor-minimal',
  rpcUrl: env.VITE_NATIVE_TESTNET_RPC_URL,
  chainId: Number(env.VITE_NATIVE_TESTNET_CHAIN_ID),
  factory: env.VITE_NATIVE_TESTNET_FACTORY_ADDRESS,
  paymaster: env.VITE_NATIVE_TESTNET_PAYMASTER_ADDRESS,
  passkeyModule: env.VITE_NATIVE_TESTNET_PASSKEY_MODULE_ADDRESS,
  sessionModule: env.VITE_NATIVE_TESTNET_SESSION_UNTRUSTED_MODULE_ADDRESS,
  admin: env.VITE_NATIVE_TESTNET_ADMIN_PRIVATE_KEY,
}
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

function log(...a) {
  console.log(...a)
}

async function main() {
  const rpc = new JsonRpcProvider(cfg.rpcUrl)
  const userId = `password:verify-${Date.now()}` // fresh account per run
  const sessionSigner = deriveSessionSigner(cfg.scope, userId)

  const provider = new NativeAccountProvider({
    scope: cfg.scope,
    rpcUrl: cfg.rpcUrl,
    chainId: cfg.chainId,
    contracts: { factory: cfg.factory, passkeyModule: cfg.passkeyModule, paymaster: cfg.paymaster },
    userId,
    deployerPrivateKey: cfg.admin,
    usePaymaster: true,
    // Realistic per-op gas (verification + call). The 20M default would make
    // handleOps demand ~40M gas, over the testnet block limit (AA95).
    defaultGasLimit: 1_500_000n,
    genesisAuthority: {
      kind: 'session',
      module: cfg.sessionModule,
      tier: 'low_untrusted',
      sessionSigner,
      authorityKind: 'password',
    },
  })

  log('login    :', userId)
  const res = await provider.signIn({})
  log('  account:', res.accountAddress)
  log('  authority:', JSON.stringify(res.authority), 'migration:', res.migrationStatus)
  log('  attestation:', res.attestation.slice(0, 40), '...')

  // Ensure the shared paymaster has an EntryPoint deposit to sponsor the userOp.
  const ep = new Contract(ENTRY_POINT, ['function balanceOf(address) view returns (uint256)'], rpc)
  const deposit = await ep.balanceOf(cfg.paymaster)
  log('paymaster EntryPoint deposit:', formatEther(deposit), 'ETH')
  if (deposit < 1_000_000_000_000_000n) {
    log('  funding paymaster (0.002 ETH)…')
    const admin = new Wallet(cfg.admin, rpc)
    const tx = await admin.sendTransaction({ to: cfg.paymaster, value: 2_000_000_000_000_000n })
    await tx.wait()
    log('  funded:', tx.hash)
  }

  log('deploy   : CREATE2 via factory…')
  await provider.ensureDeployed()
  log('  deployed:', await provider.isDeployed())

  let st = await provider.getAuthorityState()
  log('state    : passkeyCount=%d upgradeLocked=%s migration=%s', st.passkeyCount, st.upgradeLocked, st.migrationStatus)

  log('upgrade  : enrollFirstPasskey (session-signed → ratchet)…')
  // Do the enroll via sendTransaction so we get the receipt + can decode the
  // EntryPoint events (success flag / any revert reason) for diagnosis.
  const pub = await new DeterministicPasskeySigner(userId).publicKey()
  const enrollData = ACCOUNT_IFACE.encodeFunctionData('enrollFirstPasskey', [
    0,
    cfg.passkeyModule,
    encodePasskeyConfig(pub),
  ])
  const receipt = await provider.sendTransaction({ to: res.accountAddress, data: enrollData, authorityId: 0 })
  log('  enroll handleOps tx:', receipt.hash, 'status', receipt.status)
  for (const lg of receipt.logs) {
    if (lg.address.toLowerCase() !== ENTRY_POINT.toLowerCase()) continue
    let parsed
    try {
      parsed = EP_IFACE.parseLog(lg)
    } catch {
      continue
    }
    if (!parsed) continue
    if (parsed.name === 'UserOperationEvent') {
      log('    UserOperationEvent: success =', parsed.args.success)
    } else {
      log(`    ${parsed.name}:`, parsed.args.revertReason)
    }
  }

  // Public RPCs serve stale reads for a few seconds after a tx. Wait for
  // the state to propagate before asserting.
  await new Promise((r) => setTimeout(r, 8000))
  st = await provider.getAuthorityState()
  const records = await provider.listAuthorities()
  log('state    : passkeyCount=%d upgradeLocked=%s migration=%s', st.passkeyCount, st.upgradeLocked, st.migrationStatus)
  log('authorities:')
  for (const r of records) log('  #%d %s (%s) active=%s', r.id, r.kind, r.tier, r.active)

  log('locked   : retry the OLD web2 login (must revert)…')
  let lockedOut = false
  try {
    await provider.sendTransaction({ to: res.accountAddress, value: 0n })
  } catch (err) {
    lockedOut = true
    log('  locked out as designed:', (err?.message ?? String(err)).slice(0, 80))
  }

  const ok =
    st.passkeyCount === 1 &&
    st.upgradeLocked === true &&
    records.find((r) => r.id === 0)?.active === false &&
    lockedOut
  log('\nRESULT:', ok ? '✅ PASS — web2 login mapped, upgraded, and ratchet-locked' : '❌ FAIL')
  if (!ok) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
