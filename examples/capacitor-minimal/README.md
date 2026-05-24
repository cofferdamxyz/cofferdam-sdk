# `@cofferdam/example-capacitor-minimal`

Two-mode end-to-end integration of [`@cofferdam/sdk-react`](../../packages/react) into a Vite + React + Capacitor app. The mode is picked at build time via `VITE_COFFERDAM_NETWORK`:

**`mock` mode** (α-1 default) — smallest possible integration. Demonstrates:

- `<CofferdamProvider>` mount with explicit `MockProvider` + named profile
- Drop-in `<SignInWithCofferdamButton>` (default styling)
- `useCofferdam()` hook for richer signed-in surfaces
- Profile switching at build time via `VITE_COFFERDAM_MOCK_PROFILE`

The whole mock demo is **under 60 lines of TSX** ([`src/App.tsx`](./src/App.tsx) `MockDemo`).

**`local-chain` mode** (α-2) — three-role interactive harness for the v1/zksync contracts. Demonstrates:

- `LocalChainProvider` signing three independent roles (recruiter / funder / worker) into the same anvil-zksync node
- The full corporate flow on-chain: `postContractIntent → fundContract → awardContract → checkIn → checkOut → settle`
- Live activity log with tx hashes and status — watch it side-by-side with your node terminal

Implementation: [`src/LocalChainDemo.tsx`](./src/LocalChainDemo.tsx). See [§6 below](#6-local-chain-mode-runbook) for the runbook.

---

## 1. Run as a workspace member (development inside this monorepo)

```bash
# From the cofferdam-sdk repo root:
yarn install
yarn workspace @cofferdam/example-capacitor-minimal dev
# → http://localhost:5173
```

The example resolves `@cofferdam/sdk` and `@cofferdam/sdk-react` via yarn workspace symlinks, so changes to `packages/core` or `packages/react` are picked up immediately on save (with `tsc -b --watch` running at the root).

### Switch the mock profile

```bash
# In examples/capacitor-minimal/.env (or via shell env):
VITE_COFFERDAM_MOCK_PROFILE=ofac-flagged yarn workspace @cofferdam/example-capacitor-minimal dev
```

Each profile produces a deterministic-but-distinct `appPseudonym` and `accountAddress`. See [`cofferdam-sdk/README.md` §4.8](../../README.md#48-development-mock-provider-and-named-fixtures) for the full table.

---

## 2. Run on iOS / Android (Capacitor)

Capacitor wraps the web bundle in a native shell. The native projects are scaffolded **once per machine** via `cap add`; in this example they are gitignored because they bake in machine-local paths.

```bash
yarn build               # produce dist/ for Capacitor to copy
yarn cap:add:ios         # one-time: scaffolds ios/ folder (requires Xcode)
yarn cap:add:android     # one-time: scaffolds android/ folder (requires Android Studio)
yarn cap:sync            # copy dist/ into the native projects
yarn cap:run:ios         # launch in iOS simulator
yarn cap:run:android     # launch in Android emulator
```

The first `cap:run:ios` will prompt Xcode to install signing certificates; pick a personal team. The first `cap:run:android` will prompt Android Studio to download the appropriate SDK + emulator image.

> **Capacitor 7 requires Node ≥ 20, Xcode ≥ 15, and Android Studio Hedgehog or newer.**

---

## 3. Use as a standalone template (outside the monorepo)

If you want to extract this folder as the starting point for your own Cofferdam-authenticated app:

1. Copy the folder somewhere outside the cofferdam-sdk repo.
2. Edit `package.json` and replace the workspace `*` versions with the public release-branch URLs:

   ```diff
   -  "@cofferdam/sdk": "*",
   -  "@cofferdam/sdk-react": "*",
   +  "@cofferdam/sdk": "github:OffshoreSync/cofferdam-sdk#release-core-main",
   +  "@cofferdam/sdk-react": "github:OffshoreSync/cofferdam-sdk#release-react-main",
   ```

   *(Use `release-{core,react}-tests` if you want bleeding-edge SDK builds; `release-{core,react}-main` is the stable channel.)*

3. Replace `appId` and `appName` in `capacitor.config.ts` with your app's identifiers.
4. Replace `scope: 'capacitor-minimal'` in `src/App.tsx` with your registered Cofferdam scope (e.g. `'offshoresync'`). In production this is assigned by Cofferdam at integration-onboarding time; for α-1 any string works.
5. `yarn install && yarn dev`.

The SDK's `peerDependencies` declare `@cofferdam/sdk` explicitly so both URLs must be listed. Yarn will not resolve the peer transitively from a single URL.

---

## 4. What this example deliberately does NOT do

- **No styling framework.** Uses plain CSS in [`src/index.css`](./src/index.css) so you can read the SDK integration without filtering through Tailwind/MUI/Chakra noise. The OffshoreSync reference integration ([`react-client/src/components/auth/Cofferdam/`](https://github.com/OffshoreSync/OffshoreSync/tree/main/react-client/src/components/auth/Cofferdam)) shows how to wrap the SDK with a custom MUI surface.
- **No router, no backend.** Single-page demo. Real consumer apps will route between sign-in and authenticated screens, and will exchange the `sessionToken` with their own backend for app-specific session issuance (α-3 territory).
- **No persistence.** Sign-in state lives only in React state — refresh the page and you sign out. Real apps use the SDK's session storage helpers (β phase) or roll their own with the returned `sessionToken`.
- **No real Cofferdam mobile app.** α-1 is mock-only. The button resolves in-process via `MockProvider`. α-3 swaps in the real provider that opens the Cofferdam mobile app via deep-link.

---

## 5. Files at a glance

| File | Purpose |
|---|---|
| [`package.json`](./package.json) | Workspace member, deps, Capacitor scripts |
| [`vite.config.ts`](./vite.config.ts) | Vite + React plugin, dev server on port 5173 |
| [`capacitor.config.ts`](./capacitor.config.ts) | Capacitor app id, name, `webDir` pointer |
| [`tsconfig.json`](./tsconfig.json) | Standalone TS config (does NOT use `composite: true`; not part of the root TS project graph) |
| [`index.html`](./index.html) | Vite entry point |
| [`src/main.tsx`](./src/main.tsx) | React mount |
| [`src/App.tsx`](./src/App.tsx) | Top-level switcher (mock vs local-chain) + `MockDemo` |
| [`src/LocalChainDemo.tsx`](./src/LocalChainDemo.tsx) | Three-role on-chain harness (α-2) |
| [`src/index.css`](./src/index.css) | Minimal styling |
| [`scripts/tail-chain.mjs`](./scripts/tail-chain.mjs) | RPC tx tail — decodes Receiver/Escrow calls + events live (see §6) |
| [`.env.example`](./.env.example) | Documents all `VITE_*` knobs |

---

## 6. Local-chain mode runbook

End-to-end interactive test: sign in three roles, drive the full corporate flow on-chain, watch every tx land.

### One-time setup

1. **Install monorepo deps** (top of cofferdam-sdk repo + top of OffshoreSync contracts repo):
   ```bash
   cd cofferdam-sdk && yarn install
   cd ../contracts  && yarn install
   ```
2. **Copy the env file**:
   ```bash
   cd cofferdam-sdk/examples/capacitor-minimal
   cp .env.example .env.local
   ```

### Each session (4 terminals)

**Terminal 1 — anvil-zksync node** (from `contracts/`):
```bash
yarn node:start
# anvil-zksync is now listening on http://127.0.0.1:8011 (chain 260).
# Leave it running. anvil-zksync's default output is terse — for a
# decoded per-tx log, use Terminal 4 below.
```

**Terminal 2 — deploy the v1/zksync contracts** (also from `contracts/`):
```bash
yarn deploy:v1-zksync:local
# Prints:
#   OffshoreSyncReceiver deployed at 0xAbCd…
#   OffshoreSyncEscrow   deployed at 0x1234…
# Persists the same addresses to contracts/deployments/inMemoryNode.json.
```

Copy those two addresses into `examples/capacitor-minimal/.env.local`:
```bash
VITE_COFFERDAM_NETWORK=local-chain
VITE_LOCAL_RECEIVER_ADDRESS=0xAbCd…
VITE_LOCAL_ESCROW_ADDRESS=0x1234…
```

**Terminal 3 — Vite dev server** (from `cofferdam-sdk/`):
```bash
yarn workspace @cofferdam/example-capacitor-minimal dev:local-chain
# → http://localhost:5173
```

**Terminal 4 — RPC tx tail** (decoded mirror of every Receiver/Escrow call). Optional but strongly recommended: it's the only way to actually see *what's happening* on chain in real time — anvil-zksync's stdout is too terse and the in-app activity log only captures escrow actions you fire from the buttons (it misses bind/pre-fund txs).
```bash
yarn workspace @cofferdam/example-capacitor-minimal tail
# Backfills the last 50 blocks, then tails new ones with a 10-second
# heartbeat when the chain is idle.
#
# Useful flags:
#   --backfill=500   replay deeper history on startup
#   --backfill=0     skip backfill entirely
#   --all            don't filter — print EVERY tx, not just Receiver/Escrow
#                    (handy for confirming pre-fund transfers from the admin
#                    EOA → user EOAs during sign-in)
```
Reads `RPC` / `RECEIVER` / `ESCROW` from `.env.local` automatically (falls back to `VITE_LOCAL_*` keys). Override at runtime with env: `RECEIVER=0x… ESCROW=0x… yarn workspace @cofferdam/example-capacitor-minimal tail`.

### Click through the flow

Each click below produces one or more decoded lines in Terminal 4. The `↳ Escrow.X(...)` lines are events; the lead line is the tx + the function it called.

1. Click **Sign in as Recruiter (HR)** → admin EOA pre-funds the user's deterministic address, then `Receiver.bindNullifier(account=…, nullifier=…)` lands. Both visible with `--all`; only the bind shows in default mode.
2. Click **Sign in as Funder (Finance)** → another pre-fund + bind.
3. Click **Sign in as Worker (Crew)** → another pre-fund + bind.
4. Click **1️⃣ Post intent → Finance** → one `Escrow.postContractIntent(termsHash, amount, designatedFunder)` tx. Emits `ContractDrafted(contractId=N, …)`. No funds locked yet.
5. Click **2️⃣ Fund contract #N** → one `Escrow.fundContract(contractId=N) value=0.1 ETH` tx from the Funder. Emits `ContractFunded` + `ContractPosted`. Funder's balance drops by ~0.1 ETH + gas.
6. Click **3️⃣ Award worker** → `Escrow.awardContract(contractId=N, workerAccount=…)` from the Recruiter.
7. Click **4️⃣ Check in** then **5️⃣ Check out** → two txs from the Worker (`checkIn` / `checkOut`).
8. Click **6️⃣ Settle (pay worker)** → `Escrow.settle(contractId=N)`; emits `ContractSettled(contractId=N, worker=…, amount=0.1 ETH)`. Worker's balance grows by 0.1 ETH.

If you'd rather test the α-2 self-funded path instead, click **1️⃣ Post self-funded job** after signing the Recruiter in — that's one tx that posts AND funds in a single call (the original α-2 entry point, preserved for solo operators).

### Re-running

The demo's deterministic-EOA derivation means the same `VITE_LOCAL_RECRUITER_ID=local-recruiter-1` produces the same address across runs. Two consequences:

- **anvil-zksync was restarted (chain wiped)**: just hit the page again, sign in, everything works — the bind happens fresh.
- **anvil-zksync is still up from a previous session**: the user is already bound, so the bind tx is skipped silently (the provider checks `isAccountBound` first). To get fresh users, bump the suffix in `.env.local` (`local-recruiter-2`, etc.) or restart the node.

### Switching to ZKSync Sepolia (testnet)

Same UI + flow, pointed at a real public testnet. Useful for validating the flow against a public RPC, sharing the activity log with someone outside your machine, or testing internal-track Cofferdam mobile builds against a non-ephemeral chain.

**Pre-deployed Sepolia addresses (α-2):**

| Contract | Address | Explorer |
|---|---|---|
| `OffshoreSyncReceiver` | `0xa8F46B15F53D619584a00b91559e37233869ab5a` | [sepolia.explorer.zksync.io](https://sepolia.explorer.zksync.io/address/0xa8F46B15F53D619584a00b91559e37233869ab5a) |
| `OffshoreSyncEscrow` | `0x22281d75CF1d34421e5Fc58625885b46dC309723` | [sepolia.explorer.zksync.io](https://sepolia.explorer.zksync.io/address/0x22281d75CF1d34421e5Fc58625885b46dC309723) |
| `Verifier_vc_and_disclose` (Phase 0) | `0xf23537eF06fC1283F5be80676418b71aEd81b7E5` | [sepolia.explorer.zksync.io](https://sepolia.explorer.zksync.io/address/0xf23537eF06fC1283F5be80676418b71aEd81b7E5) |

Owner: `0xfa4D920d5592289A1A0F73CA49D626EF8FE4D695` (deployer EOA; will hand off to LLC Safe for production). The Receiver/Escrow addresses are baked into the demo as defaults — you only need to set them in `.env.local` if you've redeployed.

**Switch the demo to Sepolia:**

1. Set `VITE_COFFERDAM_NETWORK=sepolia-testnet` in `.env.local`.
2. Copy the `VITE_TESTNET_*` block from [`.env.example`](./.env.example) into `.env.local` and fill in `VITE_TESTNET_ADMIN_PRIVATE_KEY` with a Sepolia-funded key that owns the deployed Receiver. **Do not commit `.env.local`** once this is set — it's a real private key with real testnet ETH.
3. Run with the dedicated script:
   ```bash
   yarn workspace @cofferdam/example-capacitor-minimal dev:sepolia-testnet
   # → http://localhost:5173 — title says "Cofferdam Sepolia Demo · testnet"
   ```

The page renders the same three-role click-through, but with:

- A `testnet` badge next to the title
- Receiver / Escrow shown as **clickable explorer links**
- Every tx hash in the activity log linked to its Sepolia explorer page
- Demo amounts scaled **100× smaller** (0.001 ETH per job vs 0.1 ETH locally), so a 0.05 ETH faucet stash covers ~25 full demo runs instead of ~2

**Admin-key budget guidance.** Each full demo run costs the admin EOA roughly:

- 3 × `bindNullifier` txs on first sign-in (~0.0003 ETH gas each, skipped on repeat sessions because identities are sticky)
- 3 × pre-fund transfers (0.005 / 0.015 / 0.005 = 0.025 ETH) — also skipped on repeat sessions if the role's deterministic EOA already has balance
- ~7 × user-EOA txs paid by the role wallets, not by admin (the admin only pre-funds once)

So the **first** run costs admin ~0.026 ETH; subsequent runs against the same role IDs cost ~0 (admin doesn't sign anything). Bump the per-role IDs in `VITE_TESTNET_*_ID` to fork off "fresh users" on demand.

**Tail script auto-detects the mode.** With `VITE_COFFERDAM_NETWORK=sepolia-testnet` in `.env.local`, `yarn tail` reads the `VITE_TESTNET_*` namespace and points at Sepolia RPC automatically. Sepolia blocks are busy — pass `--backfill=0` if you only care about your own new txs:

```bash
yarn workspace @cofferdam/example-capacitor-minimal tail --backfill=0
```

**Skip the local node entirely.** Terminal 1 (`yarn node:start`) and Terminal 2 (`deploy:v1-zksync:local`) are not needed for Sepolia mode — only the Vite dev server (`dev:sepolia-testnet`) and tail are required.

### Troubleshooting

- **"Missing VITE_LOCAL_RECEIVER_ADDRESS"** → you haven't pasted the deploy output into `.env.local` (or didn't restart Vite after editing it).
- **Sign-in error mentioning `network ... failed to detect`** → anvil-zksync isn't reachable. Check Terminal 1; the port (8011) may have been claimed by another process. Quick fix: `kill $(lsof -ti :8011)` and restart `yarn node:start`.
- **Anvil falls back to a random port** (`Failed to bind to address 0.0.0.0:8011 ... Listening on 0.0.0.0:53426`) → another anvil-zksync from a previous session is still running. Same fix as above. Note that re-deploying the contracts is mandatory after this — the addresses in `.env.local` were on the killed node, not the new one.
- **Tail prints nothing after clicking buttons** → the demo's RPC and the tail's RPC don't match, OR the deployed addresses in `.env.local` don't match what's actually on chain. Sanity check: `yarn workspace @cofferdam/example-capacitor-minimal tail --backfill=4000 --all` — if even with `--all` and a deep backfill you see nothing, your addresses are stale; redeploy and update `.env.local`.
- **Tail decodes events but shows `selector=0x71f8…` for every call** → you're on an older `tail-chain.mjs` that used `getTransaction()` instead of raw `eth_getTransactionByHash`. `0x71f8…` is the ZKSync EIP-712 envelope, not real calldata. Pull latest.
- **Fund button stays disabled** → the funder must sign in *and* a draft must exist. The button label shows `Fund contract #—` until a draft id is set.
- **Settle reverts with `NotCheckedOut`** → you skipped check-in / check-out. The buttons are in order top-to-bottom for a reason.
