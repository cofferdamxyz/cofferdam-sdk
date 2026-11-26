# cofferdam-sdk

TypeScript SDK for [Cofferdam](https://cofferdam.xyz) accounts on Base: passkey-governed ERC-4337 accounts with sponsored gas, passkey-signed session attestations a server can verify, and clients for the Cofferdam spot escrow.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange.svg)

The SDK is pre-release (v0.0.0). The API changes without notice until the first published version. Full documentation will be published at docs.cofferdam.xyz.

## Packages

| Package | Import | Contents |
|---|---|---|
| `@cofferdam/sdk` | `@cofferdam/sdk` | Everything: the `Cofferdam` class, providers, passkey and WebAuthn signers, session attestation, device handoff, the root keys of the recovery phrase, relay helpers, escrow clients |
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

`sendTransaction` resolves only when the operation itself succeeded. EntryPoint v0.7 catches a revert inside the account's call, so a mined transaction is not enough: the SDK reads the operation's `UserOperationEvent.success` and throws `UserOperationFailedError` (`reason` `reverted` with the raw `revertData`, `not_executed`, or `unknown` when no receipt comes in time) whatever the relay answered. A relay refusal is a `UserOpRelayError`: `identity_check_failed` (the identity registry refused, on the mainnet test lane) and `execution_reverted` (the call would revert) send nothing and name the error; `user_op_reverted` is mined and reverted, with `txHash`; `preflight_unavailable`, `fee_too_low`, `pre_verification_gas_too_low` and the rest are listed on the class. The provider sends its `chainId` with each operation so the plane picks the lane. `preVerificationGas` is `0n` unless configured: `preVerificationGas: 'l1-fee'` estimates it from Base's GasPriceOracle so an unsponsored operation repays the bundle's L1 data fee, and prices the operation at ethers' `maxFeePerGas` (twice the base fee plus the tip) when `eth_gasPrice` is lower.

Device management on the same provider: `listAuthorities()` (each record carries its tier, including `partner`, and a High's `probationEndsAt` in unix seconds, or `null`), `addBackupPasskey(publicKey)` (up to 3 passkeys), `revokeAuthority(id)` (the last passkey cannot be revoked), `resolveOwnAuthorityId()`. `createDeviceHandoff` and `decodeAndVerifyDeviceHandoff` encode and check the `cdh1:` QR a new device shows to an existing one. Passing `handoverKey` (the new device's X25519 public key, 0x-hex, which needs the invitation `challenge`) makes a version 2 handoff: its digest has its own domain and commits to both, so the existing device can seal the account's root keys to that key once the passkey is added (workspace decision 0081). Version 1 tokens still decode and verify; an SDK older than version 2 refuses a version 2 token.

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

## Root keys from the recovery phrase

An account's long-lived secrets that are not wallet keys all derive from its 24-word BIP-39 phrase, each under its own HKDF-SHA256 label, never on a wallet path and never from an account address (Cofferdam decision 0081). The functions are synchronous and pure, `Uint8Array` in and out:

```ts
import { deriveRootKeys, phraseSeed, deriveVaultRootKey, derivePrfEnvelopeKey, selfSecretFromPhrase, COFFERDAM_PRF_SALT } from '@cofferdam/sdk'

const { vault, messaging, recovery } = deriveRootKeys(phrase) // 32 bytes each; throws unless 24 valid words
const seed = phraseSeed(phrase)                               // the BIP-39 seed, 64 bytes, for one key at a time
const vaultKey = deriveVaultRootKey(seed)
seed.fill(0)
const envelopeKey = derivePrfEnvelopeKey(prfFirst)            // from a passkey's PRF output evaluated with COFFERDAM_PRF_SALT
const selfSecret = selfSecretFromPhrase(phrase)               // the passport secret, on ethers' default path as it always was
```

The salt, the labels and `COFFERDAM_PRF_SALT` are frozen once a Vault exists. The recovery material takes a rotation index (`deriveRecoveryKeyMaterial(seed, index)`); its curve and commitment belong to the recovery design.

## Handles, stealth addresses and handshakes

The keys and codecs of Cofferdam decision 0086 (accepted 2026-11-15; its questions 11 to 23 are open, and the code marks each one it assumes with `ASSUMPTION(0086 qNN)`). No client and no network call yet: the plane's registry, the anchor contract and the app build on these.

```ts
import {
  toHandle, handleId, phraseSeed, deriveHandleEpochKeys, generateStealthAddress, scanAnnouncement,
  handleAnchorDomain, signHandleTypedData, createHandshakeHalf, verifyHandshakeHalf,
} from '@cofferdam/sdk'

const label = toHandle('@Ana')                          // 'ana': ENS label rules, ENSIP-15, 3 to 64 characters
const id = handleId(label!)                            // keccak256("cofferdam-handle-v1:" + label)
const keys = deriveHandleEpochKeys(phraseSeed(phrase), 0) // handle key, stealth keys, meta-address, self seed of epoch 0

// payer: derive a one-time address from the meta-address it checked against the anchor
const pay = generateStealthAddress(metaAddress, factory) // account, signer, R, view tag, h; factory from your configuration

// recipient: scan an announcement with the viewing key
const mine = scanAnnouncement(announcement, { viewingPrivateKey, spendingPublicKey, factory })

// anchor calls and registry requests are EIP-712, signed by the handle key
const sig = signHandleTypedData(keys.handleKey.privateKey, handleAnchorDomain(84532, anchorAddress), 'Release', { handleId: id, nonce, deadline })

// handshake: a signed half with a fresh X25519 key, checked against the anchor's owner
const { half, ephemeralPrivateKey } = createHandshakeHalf({ handleKey, handle: 'ana', serial, inboxId, chainId: 84532, carrier: 'qr' })
verifyHandshakeHalf(half, { chainId: 84532, anchor: { owner, serial, frozen, pendingChange }, isReplay })
```

- `rootKeys.ts` gains the seed-level handle keys under their own frozen labels (`HANDLE_SEED_LABELS`): the handle root per epoch, the Tier 1 XMTP key on its own counter, the XMTP recovery identity and a releasing label's release key. Decision 0081's labels are unchanged.
- `handleRoot.ts`: an epoch's keys, the self-derived ephemeral keys by phone slot (0 to 15) and index with the recovery walk under a gap limit, and the epoch search against the anchor's `owner`.
- `stealth.ts`: ERC-5564 scheme 1 (66-byte meta-address, spending key first, compressed; `h = keccak256` of the compressed shared point, view tag `h[0]`, `P = S + h·G`), the one-time account as a CREATE2 function of a factory, and the plane's registration check `P = S + h·G` without the viewing key. The SDK ships no factory: the one-time factory of decision 0083 rule 4 does not exist yet, and the shared fixture's placeholder (`stealth.factory`) is never deployed, so an account under it can never be spent from.
- `handle.ts`: the grammar, `handleId`, and the EIP-712 domains and types of every signed anchor call and registry request.
- `handshake.ts`: the half and its reply, the pairwise secret (HKDF over X25519), the rename notice and the contact record codec (no address).
- `packages/core/test/fixtures/handleAnchorTypes.json` is the shared fixture the anchor contract's and the plane's tests read: type strings, typehashes, domain separators, a signature per type from fixed test keys, and stealth vectors. `yarn test` fails when the SDK drifts from it; `WRITE_HANDLE_FIXTURE=1 yarn test handleFixture` rewrites it.

## Ceremony attestation (EIP-712)

A Cofferdam ceremony attester co-signs the first `cofferdam.xyz` passkey on a partner-app account, the pre-High partner re-key and hard recovery (Cofferdam decision 0016). From the production account generation on, `CofferdamAccount4337` verifies that co-sign as EIP-712 typed data (decision 0090 item 5), so the attester's key can sit behind a policy that pins what it signs:

```ts
import { ceremonyDomain, ceremonyDigest, recoverCeremonySigner, CEREMONY_ACTIONS } from '@cofferdam/sdk'

// domain: ("Cofferdam Ceremony", "1", chainId, the generation's CofferdamCeremonyAttesterRegistry)
const domain = ceremonyDomain(8453, ceremonyRegistry)
const message = { account, action: CEREMONY_ACTIONS['enroll-first-high'], newKeyHash, partnerId, nonce, notBefore, expiry }
ceremonyDigest(domain, message)                         // equals the account's ceremonyHash(...)
recoverCeremonySigner(domain, message, signature)       // compare with the registry's isTrustedAttester
```

The domain names the registry, never the account; the account is in the message, so an attestation never replays on another account. Accounts of Base Sepolia's deployed generation verify EIP-191 instead; the SDK carries only the typed form. `packages/core/test/fixtures/ceremonyTypes.json` is the shared fixture the account contract's, the attester's and the plane's tests read; `WRITE_CEREMONY_FIXTURE=1 yarn test ceremonyFixture` rewrites it.

## Identity registry (passport binding)

`CofferdamIdentityRegistry` binds one person's identifier to one account; the person proves it with ZKPassport through `ZKPassportEvidenceAdapter` (Cofferdam decision 0080). The account itself calls the registry, and every proof is bound to a digest the registry hands out for the account's next action.

```ts
import { CofferdamIdentityRegistryClient, zkpEvidenceFromParams, encodeBindCall } from '@cofferdam/sdk'

const registry = new CofferdamIdentityRegistryClient({ address: identityRegistry, runner: rpcProvider })
const customData = await registry.customData('bind', account) // the ZKPassport request's custom_data
// ...ZKPassport proves bind(user_address = account, chain = base, custom_data), age >= 18, an expiry bound...
const evidence = zkpEvidenceFromParams(solidityVerifierParameters)
await registry.check('bind', account, adapter, evidence)       // eth_call pre-flight; IdentityRegistryError names the refusal
await provider.sendTransaction({ to: identityRegistry, data: encodeBindCall(adapter, evidence) })
await registry.isAccountBound(account)                         // true
```

`identityDigest` and `zkpCustomData` compute the digest off-chain; `identityRevertName` names a registry or adapter revert, such as `UserOperationFailedError.revertData`. The identifier `check` returns, and the errors' arguments, name the passport: never log, store or send them. `check` throws `IdentityRegistryError` only for a revert; a call that could not run (a node error) throws a plain `Error` that carries no part of the request. The SDK has no ZKPassport dependency; it takes the parameters ZKPassport's own SDK returns.

## Escrow

```ts
import { CofferdamEscrowFactoryClient, CofferdamSpotEscrowClient } from '@cofferdam/sdk'

const factory = new CofferdamEscrowFactoryClient({ address: escrowFactory, signer })
const { escrowAddress } = await factory.createSpotEscrow(token, policy, salt) // token on the factory's allowlist

const escrow = new CofferdamSpotEscrowClient({ address: escrowAddress, signer })
await escrow.approveToken(amount) // in the token's base units
await escrow.fund(amount)
const { state } = await escrow.getState()
```

The clients take an `ethers` `Wallet`. From a Cofferdam account, encode the call with `COFFERDAM_SPOT_ESCROW_ABI` and send it through `NativeAccountProvider.sendTransaction`. The contract flow is fund, award, optional witness, witness check-in, witness check-out (which releases the escrow's token to the worker), with refund, no-show, timeout and dispute exits.

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
| Identity registry (decision 0080): digest, `custom_data` and ZKPassport evidence encoders, registry reads and pre-flight, bind calldata; per-operation success check; L1-fee `preVerificationGas` | ✅ Built, not yet run against a deployed registry from the app |
| Passkey devices: list, add (up to 3), revoke, device-handoff QR codec (versions 1 and 2, the second with the handover key) | ✅ Built |
| `csa1:` session attestation: create and verify | ✅ Built (versions 1 and 2) |
| Root keys from the 24-word recovery phrase: the Vault, messaging and recovery keys, the PRF envelope key, the passport secret on its existing path | ✅ Built |
| Spot escrow and escrow factory clients | ✅ Built |
| Mock and local-chain providers, React bindings | ✅ Built |
| Accounts that start from a partner app's passkey; first Cofferdam passkey on such an account | 📋 Planned (the ceremony attestation's EIP-712 types, digest and signer check are built, decision 0090 item 5) |
| `csa1:` version 2: device binding, expiry, audience, fast and slow tiers | ✅ Built |
| `csa1:` version 2's `actions[]`, signed by a partner app's key | 📋 Planned |
| Handle keys and codecs of decision 0086: grammar, `handleId`, epoch keys, ERC-5564 scheme 1, EIP-712 types of the anchor and registry, handshake halves, rename notice, contact record | ✅ Built (no client yet; open questions assumed in code) |
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
