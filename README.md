# cofferdam-sdk

TypeScript SDK for [Cofferdam](https://cofferdam.xyz) accounts on Base: passkey-governed ERC-4337 accounts with sponsored gas, passkey-signed session attestations a server can verify, and clients for the Cofferdam spot escrow.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange.svg)

The SDK is pre-release (v0.0.0). The API changes without notice until the first published version. Full documentation will be published at docs.cofferdam.xyz.

## Packages

| Package | Import | Contents |
|---|---|---|
| `@cofferdam/sdk` | `@cofferdam/sdk` | Everything: the `Cofferdam` class, providers, passkey and WebAuthn signers, session attestation, device handoff, relay helpers, escrow clients |
| | `@cofferdam/sdk/native` | `NativeAccountProvider`: the ERC-4337 account client |
| | `@cofferdam/sdk/mock` | `MockProvider` and named test profiles (no chain, no `ethers`) |
| | `@cofferdam/sdk/local` | `LocalChainProvider`: plain EOAs on a local or test chain |
| | `@cofferdam/sdk/escrow` | `CofferdamSpotEscrowClient` and its ABI |
| `@cofferdam/sdk-react` | `@cofferdam/sdk-react` | `CofferdamProvider`, `useSignInWithCofferdam`, `useCofferdam`, `SignInWithCofferdamButton`, `useFunderPicker` |

`ethers` v6 is an optional peer dependency, needed by every entry point except `/mock`. Hashing uses `@noble/hashes`, so the SDK runs in browsers, Node 20+ and React Native (Hermes) without WebCrypto.

## Install

The packages are not on npm yet. CI publishes each package as a release branch on every push to `main`, with the built package at the branch root:

```jsonc
// package.json
{
  "dependencies": {
    "@cofferdam/sdk": "github:cofferdamxyz/cofferdam-sdk#release-core-main",
    "@cofferdam/sdk-react": "github:cofferdamxyz/cofferdam-sdk#release-react-main",
    "ethers": "^6.13.0"
  }
}
```

List both packages when you use React: `@cofferdam/sdk-react` takes `@cofferdam/sdk` as a peer dependency. Release branches are force-pushed, so run `yarn install --force` to pick up a new snapshot, or pin a release-branch commit SHA for reproducible installs. A push to a `tests` branch produces `release-core-tests` and `release-react-tests` the same way.

## Quick start: a passkey account

`NativeAccountProvider` derives a counterfactual `CofferdamAccount4337` address from the factory, signs user operations with a passkey, and sends them to a relay that pays gas through a paymaster. The first operation deploys the account. No client key holds funds or pays gas.

```ts
import { NativeAccountProvider, WebAuthnPasskeySigner } from '@cofferdam/sdk'

// `publicKey` ({ qx, qy }) was captured when the passkey was created
// (p256PublicKeyFromDer helps); `authenticator` runs the platform's
// passkey assertion over a 32-byte challenge.
const signer = new WebAuthnPasskeySigner(publicKey, authenticator)

const provider = new NativeAccountProvider({
  scope: 'your-scope',
  rpcUrl: 'https://sepolia.base.org',
  chainId: 84532,
  contracts: { factory, passkeyModule, paymaster }, // from the base-contracts deployments
  userId,                                           // stable per account: part of the CREATE2 salt
  signer,
  relayerUrl,                                       // the Cofferdam plane: POST /v1/aa/user-operation
  usePaymaster: true,
  defaultGasLimit: 1_500_000n,                      // the relay caps verification gas at 5M
})

const address = await provider.getAccountAddress() // a view call; nothing is deployed
const session = await provider.signIn({})          // one passkey prompt; returns a csa1: attestation
await provider.ensureDeployed()                    // first sponsored op carries the factory initCode
await provider.sendTransaction({ to, data })       // execute(to, value, data), signed and relayed
```

Device management on the same provider: `listAuthorities()` (each record carries its tier, including `partner`, and a High's `probationEndsAt` in unix seconds, or `null`), `addBackupPasskey(publicKey)` (up to 3 passkeys), `revokeAuthority(id)` (the last passkey cannot be revoked), `resolveOwnAuthorityId()`. `createDeviceHandoff` and `decodeAndVerifyDeviceHandoff` encode and check the `cdh1:` QR a new device shows to an existing one.

Contract addresses are configuration; the SDK holds no address table. The Base Sepolia deployment is in [`cofferdamxyz/base-contracts`](https://github.com/cofferdamxyz/base-contracts) under `deployments/baseSepolia.json`.

The passkey module verifies passkeys for the `cofferdam.xyz` relying party, so this provider runs on Cofferdam's own surfaces. Accounts that start from a partner app's own passkey are not supported by the SDK yet (see Status).

## Verify a session attestation on your server

`SignInResponse.attestation` is a `csa1:` token: the user's passkey signing the scope, pseudonym, account, chain id, whether the account was Self-bound on-chain at sign-in, and the issue time.

```ts
import { decodeAndVerifySessionAttestation } from '@cofferdam/sdk'

const att = decodeAndVerifySessionAttestation(token, {
  expect: { scope: 'your-scope', chainId: 84532 },
  maxAgeMs: 5 * 60_000,
})
// Throws SessionAttestationDecodeError | SessionAttestationExpiredError |
// SessionAttestationVerificationError.
```

A valid token proves the holder of `att.publicKey` signed exactly these fields. It does not prove that key controls the account: check that the key is an active authority on the account on-chain (`getAuthority`), or use the Cofferdam plane's `POST /v1/session/verify-attestation` with `checkOnChain: true`. Version 1 has no audience or expiry and its `verified` flag is not a proof of identity verification; bound replay with `maxAgeMs` and `expect`. Do not store `accountAddress`: account addresses change between contract generations.

### Device-bound sessions (version 2)

Pass `session: { tier, deviceKey }` to `signIn` and the passkey signs a version 2 token instead: it expires (`fast` up to 24 hours, `slow` up to 10 minutes), names its audience, and names a device key by its RFC 7638 thumbprint. Every request then carries a proof that key signs, in the shape of RFC 9449 (DPoP), so a copied token is useless without the device:

```ts
import { createPopProof, decodeAndVerifySessionAttestationV2, verifyPopProof } from '@cofferdam/sdk'

// client: one passkey prompt, then a proof per request
const { attestation } = await provider.signIn({ session: { tier: 'fast', deviceKey } })
const dpop = await createPopProof({ deviceKey, htm: 'POST', htu: url, token: attestation })
// send Authorization: DPoP <attestation> and DPoP: <dpop>

// server: the envelope, then the proof, then record proof.jti once
const att = decodeAndVerifySessionAttestationV2(attestation, { expect: { accountAddress } })
const proof = verifyPopProof(dpop, { token: attestation, htm: 'POST', htu: url })
if (proof.jkt !== att.cnf.jkt) throw new Error('not signed by the session device key')
```

`deviceKey` is any `DeviceKeySigner`: the Cofferdam app's is a Secure Enclave or Keystore key; `SoftwareDeviceKeySigner` is for tests. The verifier must also refuse a `jti` it has seen before.

## Escrow

```ts
import { CofferdamEscrowFactoryClient, CofferdamSpotEscrowClient } from '@cofferdam/sdk'

const factory = new CofferdamEscrowFactoryClient({ address: escrowFactory, signer })
const { escrowAddress } = await factory.createSpotEscrow(policy, salt)

const escrow = new CofferdamSpotEscrowClient({ address: escrowAddress, signer })
await escrow.approveUSDC(amount)
await escrow.fund(amount)
const { state } = await escrow.getState()
```

The clients take an `ethers` `Wallet`. From a Cofferdam account, encode the call with `COFFERDAM_SPOT_ESCROW_ABI` and send it through `NativeAccountProvider.sendTransaction`. The contract flow is fund, award, optional witness, witness check-in, witness check-out (which releases USDC to the worker), with refund, no-show, timeout and dispute exits.

## React

```tsx
import { CofferdamProvider, SignInWithCofferdamButton } from '@cofferdam/sdk-react'

<CofferdamProvider config={{ scope: 'your-scope', scopeDisplayName: 'Your App', network: 'mock' }}>
  <SignInWithCofferdamButton onSignedIn={(session) => console.log(session.appPseudonym)} />
</CofferdamProvider>
```

`SignInWithCofferdamButton` is the Cofferdam brand's primary button (near-black with a white label on light pages, white with black on dark ones, following `prefers-color-scheme` or a `[data-theme]` ancestor). Set `--cofferdam-button-bg` and `--cofferdam-button-fg` to override the pair, pass `fullWidth`, a `leadingIcon` or a CSP `nonce`.

`network: 'mock'` builds a `MockProvider`; any other network takes a `provider` in the config. `useFunderPicker` keeps recent funder addresses in `localStorage` and works on the web only.

## Development without a chain

```ts
import { MockProvider, mockProfiles } from '@cofferdam/sdk/mock'

const provider = new MockProvider({ scope: 'your-scope', ...mockProfiles['verified-br'] })
```

Profiles: `verified-br`, `verified-us`, `unverified`, `ofac-flagged`, `stale-proof`. `examples/capacitor-minimal/` is a Vite + React + Capacitor app that mounts the provider and the button (`yarn dev` in that folder runs it in mock mode).

## Status

| Area | Status |
|---|---|
| Passkey account: address derivation, sponsored relayed operations, first-op deployment | ✅ Built, used by the Cofferdam app on Base Sepolia |
| Passkey devices: list, add (up to 3), revoke, device-handoff QR codec | ✅ Built |
| `csa1:` session attestation: create and verify | ✅ Built (versions 1 and 2) |
| Spot escrow and escrow factory clients | ✅ Built |
| Mock and local-chain providers, React bindings | ✅ Built |
| Accounts that start from a partner app's passkey; first Cofferdam passkey on such an account | 📋 Planned |
| `csa1:` version 2: device binding, expiry, audience, fast and slow tiers | ✅ Built |
| `csa1:` version 2's `actions[]`, signed by a partner app's key | 📋 Planned |
| Handle resolution (pay a user by handle, verified against an on-chain anchor) | 📋 Planned |
| Account generations: enumerate a user's earlier account addresses and move their balances | 📋 Planned |
| Account recovery client | 📋 Planned |
| `appPseudonym` stable across account generations | 📋 Planned; today it is derived from the account address |
| npm publication | 📋 Planned |

Some exported names (`upgradeToPasskey`, the `low_untrusted` tier, `allowInBrowserPasskey`) belong to an authority model the contracts no longer support and will be removed.

## Development

```bash
yarn install
yarn build      # tsc -b, all packages
yarn test       # vitest run
yarn typecheck  # packages, their tests (tsconfig.test.json) and the example
yarn lint       # typescript-eslint, type-checked (eslint.config.mjs)
```

Node 24 (`.nvmrc`), yarn 1. The account and local-chain integration tests run against a local Base node at `127.0.0.1:8545` (chain 31337) with the contracts from `base-contracts` deployed (`yarn deploy:local`); without it they skip. Set `COFFERDAM_LOCAL_INTEGRATION=1` to make a missing node fail the run.

## License

MIT, see [LICENSE](LICENSE). Copyright 2026 Cofferdam Inc.
