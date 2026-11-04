# @cofferdam/sdk

Framework-agnostic TypeScript core of the Cofferdam SDK for Base: passkey-governed ERC-4337 accounts with sponsored gas, `csa1:` session attestations a server can verify, the device-handoff QR codec, and clients for the Cofferdam spot escrow and escrow factory.

Pre-release (v0.0.0); the API changes without notice until the first published version.

## Install

Not on npm yet. Install the release branch CI builds from `main`:

```jsonc
"@cofferdam/sdk": "github:cofferdamxyz/cofferdam-sdk#release-core-main",
"ethers": "^6.13.0"
```

## Entry points

| Import | Contents |
|---|---|
| `@cofferdam/sdk` | Everything, including `Cofferdam`, signers, session attestation, device handoff, relay helpers, escrow clients |
| `@cofferdam/sdk/native` | `NativeAccountProvider` |
| `@cofferdam/sdk/mock` | `MockProvider`, `mockProfiles` (no `ethers`) |
| `@cofferdam/sdk/local` | `LocalChainProvider` |
| `@cofferdam/sdk/escrow` | `CofferdamSpotEscrowClient`, `COFFERDAM_SPOT_ESCROW_ABI` |

`ethers` v6 is an optional peer dependency, needed by every entry point except `/mock`. Hashing uses `@noble/hashes`, so the package runs in browsers, Node 20+ and React Native without WebCrypto.

## Documentation

Quick start, server-side attestation verification, escrow usage and status: the [repository README](https://github.com/cofferdamxyz/cofferdam-sdk#readme). Full documentation will be published at docs.cofferdam.xyz.

## License

MIT. Copyright 2026 Cofferdam Inc.
