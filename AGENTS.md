# AGENTS Instructions

## Scope

These instructions apply to `cofferdam-sdk/`.

## Demand-Driven Development

The SDK is built feature-by-feature, driven by consumer needs. Partial contract coverage is intentional. Do not bulk-generate enterprise clients. Add a client only when a consumer surface requires it.

## Cross-Repo Coupling

- `cofferdam-api/src/services/sessionAttestation.ts` must stay byte-compatible with `cofferdam-sdk/packages/core/src/identity/sessionAttestation.ts`.
- `expo-client` is the demand-driving consumer for `@cofferdam/sdk-react-native` and a generic Assignment client. Implement only the methods required by active OffshoreSync slices; Assignment settlement references remain optional.
- On-chain passkey authority config (`encodePasskeyConfig`) must match `PasskeyAuthority` and `WebAuthnPasskeyAuthority` config in `contracts/v2/auth/authorities/`.
- After editing SDK source, run `yarn build` in `packages/core` and copy `dist/` into `cofferdam-app/node_modules/@cofferdam/sdk/dist` (the app uses a file dep copied, not symlinked).

## Documentation

Every SDK change must update in the same PR: client ABI, methods, JSDoc, SDK README, and any `base-contracts/README` sections the change invalidates.

## Naming

Cofferdam internals use `Cofferdam*` identifiers, not `OffshoreSync*`. Exceptions: `scope: 'offshoresync'`, references to OffshoreSync-the-product in docs, and the `react-client`/`react-server` consumer repos. Rename ladder is in `../rules/cofferdam-sdk.md`.

## References

- Workspace rules: `../AGENTS.md` (Cofferdam workspace) and the cross-entity index one level above
- `../rules/cofferdam-sdk.md`
- `../rules/cofferdam-identity.md`
- `../rules/cofferdam-enterprise.md`
- `../.claude/skills/add-cofferdam-sdk-client/SKILL.md`
- `../.claude/skills/add-cofferdam-escrow-client/SKILL.md`
- `../.claude/skills/add-cofferdam-spot-escrow/SKILL.md`
