# `@cofferdam/example-capacitor-minimal`

Smallest possible end-to-end integration of [`@cofferdam/sdk-react`](../../packages/react) into a Vite + React + Capacitor app. Demonstrates:

- `<CofferdamProvider>` mount with explicit `MockProvider` + named profile
- Drop-in `<SignInWithCofferdamButton>` (default styling)
- `useCofferdam()` hook for richer signed-in surfaces
- Profile switching at build time via `VITE_COFFERDAM_MOCK_PROFILE`

The whole demo is **under 80 lines of TSX** ([`src/App.tsx`](./src/App.tsx)). Use it as the starting template for your own Cofferdam-authenticated Capacitor app.

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
| [`src/App.tsx`](./src/App.tsx) | The actual SDK integration (read this!) |
| [`src/index.css`](./src/index.css) | Minimal styling |
| [`.env.example`](./.env.example) | Documents `VITE_COFFERDAM_MOCK_PROFILE` |
