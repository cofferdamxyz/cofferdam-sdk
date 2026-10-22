# REVIEW.md — cofferdam-sdk

Read with `AGENTS.md` and the workspace `docs/architecture/sdk.md`. Here failure means **it signs or encodes bytes the chain or the plane will not accept, or hands an integrator something it must never hold**.

## What failure looks like

- `packages/core/src/identity/**`: `sessionAttestation.ts` no longer byte-compatible with `cofferdam-api/src/services/sessionAttestation.ts`; `encodePasskeyConfig`, the Partner config or the genesis `Permission` tuple not matching `base-contracts/contracts/auth/` byte for byte (the tuple is a CREATE2 input: a wrong byte is a different account). High risk.
- Hashing through WebCrypto (`crypto.subtle`) instead of `@noble/hashes` (Hermes has none).
- An address table, or a default address baked into the package (addresses come from the caller's configuration).
- A new surface that returns or stores an account address for a consumer app, or keys a user by anything but the handle (decision 0025).
- A client nobody consumes yet (demand-driven: an active consumer must need it), or an `OffshoreSync*` name for a Cofferdam internal.
- A public method with no JSDoc, or a change to the API with no README and no `docs/architecture/sdk.md` update.

## Skip

- `dist/` and lockfile churn.

## How to report

- Every finding names a file and line and quotes the code or text that is wrong. A guess from a name or a path is not a finding.
- Tag each one **Important** (wrong behaviour, a broken rule above, a security or money risk), **Nit** (at most three per review; style alone is never one) or **Pre-existing** (true, but not introduced by this diff; never blamed on it).
- Flag a class of bug once with every instance, not one finding per line. Do not repeat a finding already answered in an earlier round; after the second round read only the new diff.
- Start the summary with the count ("2 Important, 1 Nit, 1 Pre-existing"), and say "Nothing to fix" plainly when that is the result.
- Name the risk tier the diff falls in (workspace `docs/runbooks/code-review.md`).
