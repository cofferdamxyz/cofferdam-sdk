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

### Each session (3 terminals)

**Terminal 1 — anvil-zksync node** (from `contracts/`):
```bash
yarn node:start
# anvil-zksync is now listening on http://127.0.0.1:8011 (chain 260).
# Leave it running. Every tx the demo fires will print here.
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

### Click through the flow

1. Click **Sign in as Recruiter (HR)** → Terminal 1 shows a `bindNullifier` tx + a pre-fund transfer.
2. Click **Sign in as Funder (Finance)** → another bind + pre-fund.
3. Click **Sign in as Worker (Crew)** → another bind + pre-fund.
4. Click **1️⃣ Post intent → Finance** → one `postContractIntent` tx. The activity row shows the contract id (e.g. `contract #1`); no funds locked yet.
5. Click **2️⃣ Fund contract #1** → one `fundContract` tx from the Funder, with `value = 0.1 ETH`. Funder's balance drops by ~0.1 ETH + gas.
6. Click **3️⃣ Award worker** → `awardContract` tx from the Recruiter.
7. Click **4️⃣ Check in** then **5️⃣ Check out** → two txs from the Worker.
8. Click **6️⃣ Settle (pay worker)** → final tx; Worker's balance grows by `0.1 ETH`.

If you'd rather test the α-2 self-funded path instead, click **1️⃣ Post self-funded job** after signing the Recruiter in — that's one tx that posts AND funds in a single call (the original α-2 entry point, preserved for solo operators).

### Re-running

The demo's deterministic-EOA derivation means the same `VITE_LOCAL_RECRUITER_ID=local-recruiter-1` produces the same address across runs. Two consequences:

- **anvil-zksync was restarted (chain wiped)**: just hit the page again, sign in, everything works — the bind happens fresh.
- **anvil-zksync is still up from a previous session**: the user is already bound, so the bind tx is skipped silently (the provider checks `isAccountBound` first). To get fresh users, bump the suffix in `.env.local` (`local-recruiter-2`, etc.) or restart the node.

### Troubleshooting

- **"Missing VITE_LOCAL_RECEIVER_ADDRESS"** → you haven't pasted the deploy output into `.env.local` (or didn't restart Vite after editing it).
- **Sign-in error mentioning `network ... failed to detect`** → anvil-zksync isn't reachable. Check Terminal 1; the port (8011) may have been claimed by another process.
- **Fund button stays disabled** → the funder must sign in *and* a draft must exist. The button label shows `Fund contract #—` until a draft id is set.
- **Settle reverts with `NotCheckedOut`** → you skipped check-in / check-out. The buttons are in order top-to-bottom for a reason.
