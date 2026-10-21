# AGENTS Instructions

## Scope

These instructions apply to `cofferdam-sdk/`.

## Demand-Driven Development

The SDK is built feature-by-feature, driven by consumer needs. Partial contract coverage is intentional. Do not bulk-generate enterprise clients. Add a client only when a consumer surface requires it.

## Cross-Repo Coupling

- `cofferdam-api/src/services/sessionAttestation.ts` must stay byte-compatible with `cofferdam-sdk/packages/core/src/identity/sessionAttestation.ts`.
- `cofferdam-app` is the demand-driving consumer today; partner apps (OffshoreSync first) drive the rest. Implement only the methods an active consumer needs.
- On-chain authority config must match the modules in `base-contracts/contracts/auth/` (`encodePasskeyConfig` for `WebAuthnPasskeyAuthority` / `PasskeyAuthority`, the Partner config, the genesis `Permission` tuple byte for byte, since it is a CREATE2 input).
- After editing SDK source, run `yarn build` and copy `packages/core/dist/` into `cofferdam-app/node_modules/@cofferdam/sdk/dist` (the app uses a file dependency copy, not a symlink).

## Invariants

- No address table: addresses come from the caller's configuration. The decision 0025 generation table is the one planned exception.
- Hash with `@noble/hashes`; never WebCrypto (Hermes has none).
- TypeScript runs with `exactOptionalPropertyTypes`, `noUnusedLocals` / `noUnusedParameters` and `verbatimModuleSyntax` (`tsconfig.base.json`), and the tests are typechecked (`tsconfig.test.json`). An optional field a caller may pass as `undefined` is typed `field?: T | undefined`. ESLint (`eslint.config.mjs`) only warns on the `any` from ethers `Contract` methods in `packages/core/src/escrow/` until those clients are typed.
- Integrators resolve users by handle and never store an account address (decision 0025); new surfaces must not hand one to a consumer app.
- The `enrollFirstHigh` client, `csa1:` v2 and the address-set derivation are planned; see `docs/architecture/sdk.md` in the workspace.

## Documentation

Every SDK change updates in the same change: client ABI, methods, JSDoc, this repository's README, and the workspace `docs/architecture/sdk.md` (plus `identity.md` or `contracts.md` when invariants move).

## Naming

Cofferdam internals use `Cofferdam*` identifiers, not `OffshoreSync*`. Exceptions: `scope: 'offshoresync'`, references to OffshoreSync-the-product in docs, and the `react-client`/`react-server` consumer repos. Details in `../rules/cofferdam-sdk.md`.

## References

- Workspace rules: `../AGENTS.md` (Cofferdam workspace) and the cross-entity index one level above
- `../rules/cofferdam-sdk.md`
- `../rules/cofferdam-identity.md`
- `../rules/cofferdam-enterprise.md`
- `../.claude/skills/add-cofferdam-sdk-client/SKILL.md`
- `../.claude/skills/add-cofferdam-spot-escrow/SKILL.md`
