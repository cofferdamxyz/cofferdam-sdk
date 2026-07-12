# `cofferdam-sdk` Identity Layer — Design (T1.1)

> **Status.** Design spec for `T1.1 — SDK identity layer α-3` per
> `@/Users/hoff/OffshoreSync/TODO.md`. Written first; implementation
> follows this doc.
>
> **Identity rail.** The production identity rail is the **v2
> NullifierRegistry on Base**, attested by a Self prover running in
> Cofferdam's **own open-source `cofferdam-prover` Worker** — a
> **Cloudflare Container** with service-binding-only ingress,
> egress-allowlisted, stateless, and reproducibly built. The Groth16
> proof is **verified on-chain on Base by Cofferdam itself**; there is
> no third-party bridge or external verifier anywhere in the path.
> **No TEE is required** — the prover's security properties come from
> open-source auditability, reproducible builds, operational hardening
> (§5), and the on-chain `SelfAttesterRegistry` kill-switch. A formal
> TEE-attestation upgrade (AWS Nitro Enclave) remains an **optional**
> Phase γ hardening, not a dependency. See
> `@/Users/hoff/OffshoreSync/financial/REVENUE_MODEL.md` §10.1 +
> §11 for the financial implications of this stack decision.
>
> **Rev-7.1 (2026-06-01) — Enterprise alignment patch.** Extends this
> doc to cover the **two-tier identity binding** introduced by
> `@/Users/hoff/OffshoreSync/ENTERPRISE_MODULE_PLAN.md` §3.3: a third
> provider variant — `CofferdamEnterpriseProvider` — bootstraps an
> AA on ZKSync Era from a Polis SSO session (no Self.xyz on the
> critical path), and the SDK gains a **post-employment recovery
> ceremony** primitive that lets a worker convert a company-bound
> AA to sovereign Self-bound *after* their corporate SSO has been
> revoked. The §3.0 bind flow is unchanged for sovereign-first
> consumers (Cofferdam RN app, OffshoreSync social); the new §3.10
> covers the enterprise-first path; §7 multi-device primitives are
> extended with the new error/recovery shapes. See the new §3.11
> below for the **post-employment Self-bind recovery ceremony**
> referenced from `ENTERPRISE_MODULE_PLAN.md` §3.3.2 + §3.3.4.
>
> **Rev-7.6 (2026-06-04) — plane/consumer boundary.** The enterprise AA
> bootstrap + recovery primitives here run on the **Cofferdam plane**
> (`cofferdam-api` + Neon Postgres + on-chain), never inside a consumer app.
> **No consumer ever holds a wallet address:** the plane resolves
> pseudonym→AA address server-side and the SDK returns labels/roles/balances,
> not addresses. MongoDB is consumer-only; the plane has none. See
> `ENTERPRISE_MODULE_PLAN.md` §0.
>
> **Rev-7.7 (2026-06-05) — Tiered authority model + consumer password→passkey
> migration.** Adds §2.5 (authority tiers + the one-way upgrade ratchet) and
> §3.12 (the consumer migration flow). Invariant: **every login — local
> password, Google/Apple OAuth, Polis SSO, or passkey — binds to an AA**;
> non-passkey logins are **low-tier** authorities upgradeable to a **high-tier
> device passkey**. For *untrusted* low-tier (password / social OAuth) the
> upgrade is a **one-way ratchet** — it may authorise only the first-passkey
> enrolment, then is permanently locked out, so a leaked credential can never
> add an attacker passkey. *Managed* low-tier (`PolisSessionAuthority`) is the
> deliberate exception (IdP-brokered, centrally SCIM-revocable, persists with
> OR semantics — §2.4 / §3.10). Mirrors the Uniswap in-app-wallet UX but on
> ZKSync Era native AA + Secure-Enclave passkey instead of Privy MPC, with
> **no seed phrase** (recovery = a second passkey or Self.xyz re-bind).

## Table of contents

- [1. What ships in T1.1](#1-what-ships-in-t11)
- [2. The two providers](#2-the-two-providers)
- [3. The bind flow, end to end](#3-the-bind-flow-end-to-end)
- [4. Cloudflare Container Self prover — image specification](#4-cloudflare-container-self-prover--image-specification)
- [5. Privacy-preserving parameters](#5-privacy-preserving-parameters)
- [6. Workers AI `parseDocument` primitive (Vault parser)](#6-workers-ai-parsedocument-primitive-vault-parser)
- [7. Multi-device reconciliation primitives](#7-multi-device-reconciliation-primitives)
- [8. Trust model + Phase γ TEE-attestation upgrade path](#8-trust-model--phase-γ-tee-attestation-upgrade-path)
- [9. What this doc deliberately does not specify](#9-what-this-doc-deliberately-does-not-specify)
- [10. Build + test plan](#10-build--test-plan)

---

## 1. What ships in T1.1

A single, coherent identity layer that replaces every `MockProvider`
reference in production code paths with the real Base flow.
The deliverable is **four sub-packages + one Cloudflare service +
one v2 contract deploy**:

| Sub-package / service | Purpose | New? |
|---|---|---|
| `@cofferdam/sdk` (`packages/core`) — provider interfaces, identity primitives | Already exists; receives `CofferdamNativeProvider` + `CofferdamAppProvider` additions | extends existing |
| `@cofferdam/sdk-react-native` (`packages/react-native`) | Native Secure Enclave / StrongBox passkey bridge for the Cofferdam RN app | **NEW** |
| `@cofferdam/sdk-enterprise` (`packages/enterprise`) | Tenant + KYB + Polis SSO + Safe deploy primitives (vertical-agnostic, scoped under T3 in `ENTERPRISE_MODULE_PLAN.md`) | **NEW** (lifted from OffshoreSync's backend per the SDK-first restructure) |
| `@cofferdam/sdk-vault` (`packages/vault`) | Workers AI `parseDocument` primitive — consumer brings prompt + schema | **NEW** |
| Cloudflare Container `cofferdam-prover` | Self.xyz Groth16 prover wrapped in a reproducible-build image | **NEW** |
| `contracts/contracts/v2/self/NullifierRegistry` deploy on Base Sepolia + Base Mainnet | v2 production ingress (replaces the legacy cross-chain bridge path) | deploy of already-audited code |

Phases (executable in roughly the order listed; ranges overlap by
~30%):

```
Week 0 ─── design doc lock (this doc)
Week 1-2 ─ CofferdamNativeProvider — passkey + Secure Enclave bridge
Week 2-3 ─ CofferdamAppProvider — web deep-link round-trip
Week 3-4 ─ v2 NullifierRegistry deploy on Base Sepolia
Week 4-6 ─ Cloudflare Container Self prover — image build + R2 SRS + smoke
Week 5-7 ─ End-to-end: passkey → prove → attester sign → bindNullifier
Week 6-8 ─ Multi-device reconciliation primitives (§7)
Week 7-8 ─ @cofferdam/sdk-vault Workers AI parseDocument + Gemma-4-26B
Week 8-9 ─ Integration tests + E2E recordings + replace MockProvider refs
```

Total ~3 person-months, single critical path, no cross-vendor
coordination.

## 2. The two providers

The α-1 + α-2 era shipped `MockProvider` and `LocalChainProvider`
(see `@/Users/hoff/OffshoreSync/cofferdam-sdk/packages/core/src/providers/`). T1.1
adds the production pair that replaces them.

### 2.1 `CofferdamNativeProvider` — for the Cofferdam React Native app

**Hosts.** The Cofferdam RN app itself (the user's primary device).

**Owns.** Passkey lives in iOS Secure Enclave / Android StrongBox —
hardware-bound, non-exportable, biometric-gated. Smart account is
on-chain on Base (ERC-4337 account); the passkey is the validator key.

**Responsibilities.**

1. **Account deploy.** First-passkey-on-first-device — call the
   Base ERC-4337 account factory; deploy the smart account with the
   passkey as the sole initial validator (≤3 passkeys per AA
   enforced on-chain by `CofferdamAccountValidator` per
   `cofferdam-app/ARCHITECTURE.md` §3.3).
2. **Passkey signing.** Native WebAuthn ceremony (P-256, ES256
   COSE algorithm). Returns a signature compatible with
   `CofferdamAccountValidator.isValidSignature(hash, signature)`.
3. **AA tx submission.** Wraps the signed UserOp + submits via the
   Cofferdam paymaster (sponsored gas).
4. **Passport prove orchestration.** Coordinates with the
   Cloudflare Container prover (§4) — the RN app sends the
   pre-NFC passport handle to the Container endpoint and receives
   back the Groth16 proof + nullifier; then submits the attester-
   signed `bindNullifier` tx to v2 `NullifierRegistry` on Base.
5. **Multi-device follower flow.** Subsequent devices add a
   passkey to the existing AA via the `addPasskey` validator path,
   gated by an existing-device approval (per `cofferdam-app/ARCHITECTURE.md`
   §3.3 + §3.6).

**Implements.** `CofferdamProvider` from
`@/Users/hoff/OffshoreSync/cofferdam-sdk/packages/core/src/types.ts`. The interface
shape is unchanged from α-1; only the implementation behind it is
real now.

### 2.2 `CofferdamAppProvider` — for web SDK consumers

**Hosts.** Any browser-context Cofferdam consumer — `react-client/`
(OffshoreSync social), `react-enterprise/` (OffshoreSync enterprise
dashboard, future verticals), third-party Tier-2/Tier-3 integrators.

**Owns.** No keys. Zero secrets. The web side is a thin shell.

**Responsibilities.**

1. **Deep-link round-trip** to the Cofferdam RN app for any signing
   ceremony — passkey signature, AA tx submission, passport bind.
2. **Cloudflare-Worker-mediated session exchange.** Web side opens
   a Worker session; RN app signs + posts the response back via
   Universal-Link return; Worker brokers the handshake.
3. **Read-only chain calls.** Direct Base RPC for
   `isAccountBound`, `accountToNullifier`, contract reads. No
   signing → no provider dependency for reads.
4. **Returns** the same `SignInResponse` shape as the native
   provider — consumer code is provider-agnostic.

**Implements.** `CofferdamProvider`. Same interface.

### 2.3 Why two providers and not one

Web SDK consumers cannot host a hardware-backed passkey in a
browser — WebAuthn in-browser is fine for *first-party* sites but
cross-app passkey sharing is not a thing in 2026. The native
provider holds the key; the web provider is a remote-signer client
talking to the native provider. *(Refined 2026-07-04 by §2.6: for
**natively-wrapped, Cofferdam-associated** consumer binaries,
OS-level domain association does make cross-app `cofferdam.xyz`
ceremonies possible; the claim above stands for pure-browser
origins.)*

This split also gives us **per-platform paymaster routing** without
the SDK consumer having to know: the native provider pays through
the user's own session-bound paymaster envelope; the web provider
pays through the consumer-app's per-tenant paymaster sub-pool
(Tier 2/3 per `financial/REVENUE_MODEL.md` §8). Same SDK call;
different payer under the hood.

### 2.4 `CofferdamEnterpriseProvider` — for company-bound enterprise sign-in (rev-7.1)

**Hosts.** Any consumer's enterprise dashboard — the provider ships in
`@cofferdam/sdk-enterprise` and the host is just a consumer of it. Two
deployments today: Cofferdam's own first-party `cofferdam.xyz/enterprise`,
and OffshoreSync's maritime `enterprise.offshoresync.com`
(`react-enterprise/`, embedding the module per `ENTERPRISE_MODULE_PLAN.md`
rev-7.3). Shipped by Phase E-1.5 of `ENTERPRISE_MODULE_PLAN.md` §11.

**Owns.** No keys. The AA authority is a Polis SSO ID-token verified
against the worker's IdP, not a passkey. This is the
`PolisSessionAuthority` module described in
`ENTERPRISE_MODULE_PLAN.md` §3.3.2.

> **Deployment (rev-7.5 — `ENTERPRISE_MODULE_PLAN.md` §2.6.1).** Ory Polis
> is **self-hosted open-source** (Apache-2.0); its OIDC flow + SCIM are
> **brokered by the `cofferdam-api` plane**, not the consumer's
> `react-enterprise/`/`react-server` backend. The provider initiates SSO
> through the SDK and consumes the resulting Cofferdam session; the plane
> consumes the Polis callback and invokes `cofferdam-vault`. The on-chain
> `PolisSessionAuthority` + pseudonym derivation below are unchanged.

**Responsibilities.**

1. **AA account deploy on first SSO sign-in.** When the
   `cofferdam-api` plane broker receives the Polis callback (a fresh
   ID-token for `user@mycorp.com`), it invokes the `cofferdam-vault`
   Worker which
   deterministically derives the worker's **company-bound
   pseudonym** = `keccak256(companyScopeSalt || polisSub ||
   "cofferdam-company-pseudonym-v1")`, computes the
   counterfactual AA address, and submits the Base ERC-4337 account
   factory tx with `PolisSessionAuthority` as the sole initial
   authority module (paymaster-sponsored). The contract reference
   shape matches `CofferdamAccountValidator` in §3, but the
   validator interface accepts a Polis ID-token signature instead
   of a P-256 WebAuthn signature.
2. **SSO session refresh.** Polis ID-tokens are short-lived (~1h);
   the **`cofferdam-api` plane** holds the OAuth refresh token / OIDC
   session (per §2.6.1) and re-mints ID-tokens on demand for each AA
   tx; the provider drives this through the SDK.
3. **Authority gate composition.** When the worker later binds
   Self (§3.10 / §3.11 below), this provider remains valid in
   parallel — both `PolisSessionAuthority` and
   `SelfNullifierAuthority` are registered on the AA with OR
   semantics. SSO revocation does not invalidate Self-bound
   access; Self revocation does not invalidate SSO-bound access.
4. **Returns `EnterpriseSignInResponse`** — same shape as the
   native + web providers' `SignInResponse`, with two extra
   fields: `pseudonymKind: 'company_bound' | 'sovereign'` and
   `employerRef: bytes32`. Code that doesn't care continues to
   read only the base fields; code that does care (e.g. the
   enterprise dashboard's "you have not bound a sovereign
   identity" banner) reads the extras.
5. **No Self.xyz dependency.** This provider must never import
   from `@selfxyz/*`. The Self-bind path lives in the Cofferdam RN
   app and is reached via `CofferdamNativeProvider` (or via the
   §3.11 post-employment recovery ceremony). Enforced at the
   package-boundary level — `@cofferdam/sdk-enterprise` does not
   declare `@selfxyz/mobile-sdk-alpha` as a peer dep.

**Implements.** `CofferdamProvider` from
`@/Users/hoff/OffshoreSync/cofferdam-sdk/packages/core/src/types.ts`.
Same interface as native + web; the enterprise variant lives in
`@cofferdam/sdk-enterprise` per the §1 sub-package list.

#### 2.4.1 Why three providers and not two

The web provider (§2.2) is a remote-signer client for a *consumer
who already holds a passkey*. The enterprise provider is the case
where the consumer **does not yet hold any device-bound material**:
the worker has nothing but an SSO session, and we want them to
have a fully-functional on-chain identity *anyway*. Forcing them
through the §2.1 + §2.2 passkey-first flow would re-introduce the
KYC-gating-utility error that rev-7.1 explicitly walks away from
(see `ENTERPRISE_MODULE_PLAN.md` §3.3.3).

The three providers map cleanly to the three identity surfaces:

| Provider | Authority root | Onboarding event | First-login surface |
|---|---|---|---|
| `CofferdamNativeProvider` | Device passkey | Cofferdam RN app install | Sovereign Self.xyz bind (eventually, value-gated per §3.5 of `cofferdam-app/docs/ARCHITECTURE.md`) |
| `CofferdamAppProvider` | Deep-link to native | Web SDK consumer load | Deep-link round-trip to native — no key locally |
| `CofferdamEnterpriseProvider` | Polis SSO ID-token | Worker's first sign-in at `enterprise.offshoresync.com` | Company-bound AA, no Self.xyz required |

### 2.5 Authority tiers and the one-way upgrade ratchet (rev-7.7)

The three providers above differ only in *how the first authority is
established*; they all converge on one tiered authority model on the AA.
**Every login binds to an AA** — local password, Google/Apple OAuth, Polis
SSO, or a device passkey alike — because the AA is the master identity for
all Cofferdam interactions (`cofferdam-app/docs/ARCHITECTURE.md` §3.2). The
tier of the authority that signed determines what it may do.

#### 2.5.1 The tiers

| Tier | Authority module | Established by | May sign |
|---|---|---|---|
| **High** | device passkey (P-256, Secure Enclave / StrongBox) — `CofferdamAccountValidator` | native passkey ceremony (§2.1) or QR handoff to the RN app (§2.2) | **everything** — value transfer, `addPasskey`/`addAuthority`/`revoke`, contract calls |
| **Low — untrusted** | password / social-OAuth session authority | a consumer's local-password or Google/Apple login (§3.12) | **only** enrol the *first* passkey (+ counterfactual deploy); **zero value**; nothing else |
| **Low — managed** | `PolisSessionAuthority` | enterprise Polis SSO (§2.4 / §3.10) | company-bound ops per `ENTERPRISE_MODULE_PLAN.md` §3.3.2; persists with OR semantics |

#### 2.5.2 The one-way ratchet (untrusted low-tier only)

For an **untrusted** low-tier authority — a leakable credential — the upgrade
path is a **one-way ratchet**, enforced in the AA validator:

1. The AA may deploy with the untrusted low-tier authority as its sole
   bootstrap authority.
2. That authority may authorise **exactly one** state change: enrolling the
   **first device passkey** (with zero value movement). Nothing else.
3. The instant the first passkey registers as the **high-tier** authority, the
   validator **permanently revokes the low-tier authority's
   add/remove-authority power**. From then on, **only a high-tier passkey may
   add or remove passkeys/authorities.** There is no path back.

Rationale: a leaked password or hijacked OAuth token must never be usable to
add an *attacker's* passkey and inherit full control. After the ratchet fires,
a leaked credential is inert against the wallet — it may at most still
authenticate the consumer's *app session* (a separate, non-wallet concern).

**Managed low-tier is the deliberate exception.** `PolisSessionAuthority` is
IdP-brokered, server-held, and centrally **SCIM-revocable** by the employer,
so it is not a leakable end-user credential in the same sense. It is **not**
ratchet-locked: it persists alongside a later passkey or
`SelfNullifierAuthority` with OR semantics (§3.10), and is removed only by the
§3.11 post-employment recovery (`recoverWithSelf`). This is intentional — the
employer needs continuity of control over company-bound funds.

#### 2.5.3 What the ratchet costs: recovery

Because the untrusted low-tier is locked out after the first passkey, **a
password/social login is not a recovery path.** Account recovery is exactly
two doors:

1. a **second, pre-enrolled passkey** (a backup device added while the user
   still had a working one — ≤3 per AA), or
2. a **Self.xyz re-bind** (`recoverWithSelf`, §3.11.5; `ARCHITECTURE.md` §3.3
   emergency rebind).

Two consequences the implementation MUST honour:

- The first-passkey enrolment flow (§3.12) **must immediately prompt a backup**
  — a second device and/or a Self-bind — or single-device users silently have
  no recovery.
- **Self.xyz is the recovery floor.** A single-device user who never bound a
  passport and loses the device is **unrecoverable** — the residual case
  `ENTERPRISE_MODULE_PLAN.md` §3.3.4 already acknowledges. State this honestly
  at enrolment, not at loss.

### 2.6 `CofferdamEmbeddedProvider` — embedded passkey ceremonies in natively-wrapped consumers (2026-07-04)

**Hosts.** Consumer apps that ship a *native shell* around their
web UI — Capacitor (OffshoreSync `react-client/` iOS + Android)
first; the same pattern covers any RN / native consumer binary we
or a partner sign. Pure-browser origins cannot host this provider
(see the fallback ladder below).

**Owns.** No keys — the same zero-custody posture as §2.2. The
passkey lives in the platform authenticator (iCloud Keychain /
Google Password Manager), RP-bound to `cofferdam.xyz`. The
consumer binary gains only the ability to *request* ceremonies;
every assertion is biometric-gated by the OS, and the system
sheet shows `cofferdam.xyz` — Cofferdam login, not consumer
branding.

**Mechanism.** OS-level passkey APIs, never
`navigator.credentials` — in-WebView WebAuthn is doubly
impossible: (a) WKWebView does not expose WebAuthn to non-browser
apps, and (b) a WebView origin (`capacitor://localhost`) can
never satisfy the RP-ID registrable-suffix rule for
`cofferdam.xyz` anyway. The ceremony goes through a thin native
bridge — `ASAuthorizationPlatformPublicKeyCredentialProvider(
relyingPartyIdentifier: "cofferdam.xyz")` on iOS,
`androidx.credentials.CredentialManager` (rpId `cofferdam.xyz`)
on Android — exposed to JS by a NEW `@cofferdam/sdk-capacitor`
package. The bridge implements the existing
`WebAuthnAuthenticator` seam
(`packages/core/src/identity/webauthn.ts`), so
`WebAuthnPasskeySigner`, the `WebAuthnAuth` ABI encoding, and the
on-chain `WebAuthnPasskeyAuthority` verification are reused
byte-for-byte — zero contract or core-SDK changes.

**The association registry is the trust gate.** A binary can
wield `cofferdam.xyz` passkeys only if Cofferdam lists it:

- iOS — appID under `webcredentials` in
  `cofferdam.xyz/.well-known/apple-app-site-association`;
- Android — package + signing-cert SHA-256 with
  `delegate_permission/common.get_login_creds` in
  `cofferdam.xyz/.well-known/assetlinks.json`.

Both files are server-side: adding or delisting a consumer needs
**no app release**. This registry *is* the "Cofferdam-certified
consumer" gate — association means the ability to prompt
root-authority ceremonies, so it is granted contractually
(first-party + reviewed Tier-2/3 partners) and revoked by
delisting. The long tail of consumers is never associated; they
use the fallback ladder.

**Ceremony policy (plane-enforced, not OS-enforced).** An
associated binary *can technically* request an assertion at any
time (each one still biometric-gated and challenge-bound to a tx
digest). Policy: embedded root ceremonies are for **enrolment +
authority mutations + high-tier ops only**; day-to-day consumer
traffic runs on `csa1:` session attestations. Enforcement lives
at the plane (attestation-issuance scoping + relayer policy) and
in the consumer contract — the OS cannot express it.

**The onboarding payoff.** A user who installs *only* the
consumer app gets a real `cofferdam.xyz` passkey + AA (deploy or
counterfactual) with no Cofferdam-app install — removing the
chicken-and-egg baked into §2.2. When they later install the
Cofferdam RN app, the same synced passkey is already present
(RP-bound, iCloud/GPM-synced) and §2.1 takes over as the primary
surface. The §2.5 tier model is unchanged: the embedded ceremony
establishes/exercises the **High** tier; the §2.5.2 ratchet and
§2.5.3 recovery doors apply as written.

**Fallback ladder** (runtime cascade inside the consumer SDK):

1. `CofferdamEmbeddedProvider` — native shell present **and**
   binary associated;
2. `CofferdamAppProvider` (§2.2) — Cofferdam RN app installed;
3. hosted ceremony page `id.cofferdam.xyz` via
   `ASWebAuthenticationSession` / Chrome Custom Tabs (native
   shells) or top-level redirect/popup (pure web) — WebAuthn on
   the true origin. Required for the pure-web PWA regardless of
   this provider, since cross-origin iframe
   `publickey-credentials-create` support is still patchy.

**RP-ID lock (decision).** `rpId = cofferdam.xyz` — locked. This
is Cofferdam login; ceremonies host from any `*.cofferdam.xyz`
origin and any associated binary. Passkeys do not migrate across
RP IDs, so the domain is permanent; the escape hatch for a
hypothetical future RP change is the §2.5 add-authority path
(re-enrolment on the same AA), never a credential migration.

**Implements.** `CofferdamProvider`. Same interface, same
`SignInResponse` (`appPseudonym`; no wallet address surfaces in
consumer UI — the wallet-isolation invariant is unchanged).

**Not T1.1 scope.** Tracked as **T1.5** in `TODO.md` Track 1;
buildable once T1.1's provider interface stabilises, in parallel
with T1.2–T1.4. Not mainnet-gating.

#### 2.6.1 Why four providers and not three

§2.3's "cross-app passkey sharing is not a thing" holds for
*pure-browser* consumers — an arbitrary web origin can never
assert `cofferdam.xyz` credentials. What it under-counted is that
our flagship consumers are **not pure browsers**: they are
WebViews inside binaries we (or certified partners) sign, and the
OS passkey APIs scope by **app association**, not page origin.
That turns the §2.2 remote-signer detour from a necessity into a
fallback, and makes Cofferdam login embeddable in *any* certified
consumer app as a thin SDK layer:

| Provider | Authority root | Ceremony surface | Requires |
|---|---|---|---|
| `CofferdamNativeProvider` (§2.1) | Device passkey | Cofferdam RN app | Cofferdam app install |
| `CofferdamAppProvider` (§2.2) | Deep-link to native | Cofferdam RN app (remote) | Cofferdam app install |
| `CofferdamEnterpriseProvider` (§2.4) | Polis SSO ID-token | IdP redirect | Employer IdP |
| `CofferdamEmbeddedProvider` (§2.6) | Device passkey (RP `cofferdam.xyz`) | Consumer's own binary via OS APIs | AASA / assetlinks association |

## 3. The bind flow, end to end

This is the single most important sequence in T1.1. Walk it
end-to-end once; everything else in this doc is a refinement of one
of these steps.

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│  1. User opens Cofferdam RN app, first time.                      │
│     ↓                                                             │
│  2. RN app generates a passkey in Secure Enclave / StrongBox.     │
│     - Biometric prompt for creation.                              │
│     - Public key extracted for AA deploy.                         │
│     ↓                                                             │
│  3. RN app calls Base ERC-4337 account factory (paymaster-sponsored): │
│       deploy({ validator: CofferdamAccountValidator,           │
│                initialPasskey: <P-256 pubkey> })                  │
│     - Returns smart-account address AA-x.                         │
│     - No Self.xyz yet; verified=false on first sign-in.           │
│     ↓                                                             │
│  4. SignInResponse returned to caller — user is now signed in,    │
│     unverified. Can browse, post, send P2P, use social messaging.│
│                                                                   │
│  ── value-gated Self trigger (see cofferdam-app/ARCHITECTURE.md §3.5) ──    │
│                                                                   │
│  5. User touches a feature that needs verified identity           │
│     (verified-flavor DM, contract sign, off-ramp, etc.).          │
│     ↓                                                             │
│  6. RN app initiates passport prove:                              │
│     a. NFC chip-read via @selfxyz/mobile-sdk-alpha.               │
│     b. Encrypted passport payload posted to                       │
│        https://prover.cofferdam.xyz/v1/prove (Cloudflare          │
│        Container endpoint, §4).                                   │
│     c. Container runs Self.xyz Groth16 prover libs in isolation.  │
│        Returns: (proof, nullifier, publicInputs).                 │
│     ↓                                                             │
│  7. Container posts to a Cloudflare Worker (cofferdam-attester):  │
│       attest(proof, nullifier, publicInputs, accountAddress)      │
│     - Worker holds the registered SelfAttester key (Cloudflare-   │
│       managed secret, not exposed to the Container).              │
│     - Worker signs: bindMessage = (account, nullifier, proof,     │
│       publicInputs).                                              │
│     - Returns: { attesterSignature, attesterAddress }.            │
│     ↓                                                             │
│  8. RN app submits to Base v2 NullifierRegistry:                  │
│       NullifierRegistry.verifyAndBind(                            │
│         account: AA-x,                                            │
│         a, b, c: groth16ProofPoints,                              │
│         pubSignals: uint256[21],  // nullifier = pubSignals[7],   │
│                                   // userIdentifier = [20] = AA-x │
│         attesterSig: attesterSignature                            │
│       )                                                           │
│     - The nullifier is NOT a separate arg: it is carried inside   │
│       pubSignals and bound to AA-x via pubSignals[USER_IDENTIFIER]│
│       == uint160(account). The attester address is RECOVERED from │
│       attesterSig, not passed.                                    │
│     - Contract: (a) Groth16 verifier checks proof — REAL check,  │
│       not a trusted attestation; (b) SelfAttesterRegistry.        │
│       isAuthorized(attester) check — guarantees attester is       │
│       Cofferdam-controlled; (c) one-shot binding enforced via     │
│       NullifierAlreadyBound / AccountAlreadyBound reverts.        │
│     - Paymaster sponsors the tx.                                  │
│     ↓                                                             │
│  9. Bind complete. verified=true on subsequent SignInResponses.   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Properties of this flow:**

- **No cross-chain hop.** One chain. One bind tx, verified on Base by
  our own contract.
- **Open-source prover Worker.** `cofferdam-prover` runs as a
  Cloudflare Container with service-binding-only ingress, egress
  allowlist, no persistent storage, and a reproducible build. The code
  is MIT-licensed and auditable. No TEE is required for the current
  trust model — see §5 for the full hardening parameters and §8 for
  the optional Phase γ TEE-attestation upgrade path.
- **Proof is verified on-chain.** Trust in the attester is narrow
  — the attester confirms "yes, I (Cofferdam Cloudflare backend)
  saw a proof come out of my Container that I'm willing to vouch
  for as freshly-computed." The actual Groth16 validity is checked
  by `Verifier_vc_and_disclose` on Base.
- **Same on-chain semantics as v1.** `IIdentityRegistry`-conforming;
  every consumer that reads `isAccountBound` /
  `accountToNullifier` continues to work unchanged. The escrow
  contract, the witness registry, every downstream surface — all
  identical pre- and post-v2.
- **Idempotent.** A repeat bind for the same account or the same
  nullifier reverts at the contract layer with a typed error,
  surfacing as `AccountAlreadyBoundError` /
  `NullifierAlreadyBoundError` in SDK. Multi-device reconciliation
  (§7) catches the nullifier-collision case before the tx is
  even submitted.

### 3.10 The enterprise-flavoured bind flow (rev-7.1)

The §3 flow above is the **sovereign-first** path: device passkey
materialises first, Self.xyz bind happens later, account-and-bind
both ultimately live under the worker's exclusive control. The
enterprise-flavoured flow inverts steps 1–4 — the worker gets an
on-chain AA **before** holding any device-local material, by virtue
of a corporate SSO session — and defers the §3 step 5 onwards
indefinitely. Both flows converge at the same end-state when the
worker eventually Self-binds (§3.11 below); the difference is purely
*when* the device-material ceremony happens.

```
┌───────────────────────────────────────────────────────────────────┐
│  E1. Worker signs in at enterprise.offshoresync.com with their    │
│      corporate IdP (Okta / Workday / Azure AD via Ory Polis).     │
│      Polis returns ID-token for user@mycorp.com.                  │
│      ↓                                                            │
│  E2. CofferdamEnterpriseProvider (§2.4) calls cofferdam-vault     │
│      Worker:                                                      │
│        derivePseudonym({                                          │
│          kind: 'company_bound',                                   │
│          companyScopeSalt: <per-tenant, in vault>,                │
│          polisSub: <from ID-token>,                               │
│        }) → companyBoundPseudonym                                 │
│      ↓                                                            │
│  E3. AA factory deploy on Base (paymaster-sponsored):             │
│        deployCompanyBound({                                       │
│          authority: PolisSessionAuthority,                        │
│          polisJwksRef: <IdP JWKS URL ref>,                        │
│          employerRef: <bytes32(domain)>,                          │
│          initialPseudonym: companyBoundPseudonym,                 │
│        }) → AA-x                                                  │
│      No Self.xyz. No nullifier. No passport.                      │
│      ↓                                                            │
│  E4. EnterpriseSignInResponse returned. pseudonymKind =           │
│      'company_bound'. Worker can now: co-sign sub-Safe txs,       │
│      receive USDC payroll from own-employer Payroll sub-Safe,     │
│      witness contracts issued by own employer, place into the     │
│      tenant's Merkle org tree (§4.7 of ENTERPRISE_MODULE_PLAN).   │
│                                                                   │
│  ── opt-in Self-bind trigger (worker decision, any later time) ── │
│                                                                   │
│  E5. Worker installs Cofferdam RN app, opens "Company             │
│      Bindings" page, taps "Bind sovereign identity".              │
│      ↓                                                            │
│  E6. RN app generates a device passkey (§3 step 2) AND walks      │
│      through Self.xyz NFC + Container prover + attester           │
│      (§3 steps 6–8). The Container endpoint is told the bind      │
│      target is an EXISTING AA (AA-x from E3), not a fresh         │
│      deploy.                                                      │
│      ↓                                                            │
│  E7. RN app submits the AA module-add tx:                         │
│        AA-x.addAuthority(                                         │
│          SelfNullifierAuthority,                                  │
│          { nullifier, proof, publicInputs,                        │
│            attester, attesterSig }                                │
│        )                                                          │
│      Contract: same Groth16 + SelfAttesterRegistry checks as §3   │
│      step 8, gated on the calling AA being AA-x with an active    │
│      PolisSessionAuthority signature (proving the request is      │
│      authentic at the moment of the add).                         │
│      ↓                                                            │
│  E8. AA-x now has TWO authorities with OR semantics.              │
│      cofferdam-vault recomputes the pseudonym swap                │
│      (§3.3.1 of ENTERPRISE_MODULE_PLAN):                          │
│        sovereignPseudonym = keccak256(                            │
│          companyScopeSalt || selfNullifier ||                     │
│          "cofferdam-company-pseudonym-v1")                        │
│      and emits a Merkle leaf-update batch on the next             │
│      updateOrgRoot tx. pseudonymKind transitions to 'sovereign'.  │
│      ↓                                                            │
│  E9. Subsequent EnterpriseSignInResponse → pseudonymKind =        │
│      'sovereign'. The "Company Bindings" page surfaces the        │
│      additional outward-facing capabilities (witness contracts    │
│      at OTHER companies, portable identity past employment end,   │
│      etc. — see ENTERPRISE_MODULE_PLAN §3.3 Tier 2 capability     │
│      list).                                                       │
└───────────────────────────────────────────────────────────────────┘
```

**Properties of this flow:**

- **AA-x address is stable across the transition.** No address
  rotation. All historical txs against AA-x — sub-Safe co-signs,
  USDC receipts, witness attestations — remain bound to the same
  address. The Merkle leaf is what changes, not the wallet.
- **Both authorities coexist permanently.** SSO revocation (e.g.
  worker leaves the company) does not invalidate
  `SelfNullifierAuthority`. The §3.11 post-employment recovery path
  catches the symmetric case (worker who left *before* binding
  Self).
- **One AA per (human, employer) pair.** A worker employed at
  three tenants in parallel has three AAs, one per tenant, each
  with its own `PolisSessionAuthority` keyed off the respective
  IdP's `polisSub`. Binding Self at any one of them does **not**
  link the three — each AA's `SelfNullifierAuthority` is the same
  nullifier, but the per-tenant `companyScopeSalt` keeps the
  three sovereign pseudonyms unlinkable (rev-7.1
  `ENTERPRISE_MODULE_PLAN.md` §3.3 limit row + §3.4 of this doc).
- **Idempotent on E7.** A repeat `addAuthority(SelfNullifierAuthority)`
  for an already-bound AA reverts with `AuthorityAlreadyBound`.

The SDK error surface gains one new typed error:

```ts
// cofferdam-sdk/packages/core/src/errors.ts (rev-7.1 addition)
export class AuthorityAlreadyBoundError extends CofferdamError {
  constructor(
    public readonly account: Address,
    public readonly authority: 'PolisSession' | 'SelfNullifier',
  ) { super(`Authority ${authority} already bound to ${account}`) }
}
```

### 3.11 Post-employment Self-bind recovery ceremony (rev-7.1)

The flow at §3.10 covers the **happy path**: worker is employed,
binds Self while still under active SSO. This subsection covers
the **hard case**: worker has *left* the employer (SSO revoked,
`PolisSessionAuthority` no longer mints a valid token), but
**holds a balance** in their company-bound AA — payroll deposited
to AA-x before revocation, or escrow releases that landed in the
days/weeks before termination cascaded through the SCIM pipeline.

The funds are not lost. The recovery ceremony makes them
reachable.

#### 3.11.1 The structural invariant that makes recovery possible

The company-bound pseudonym is derived as:

```
companyBoundPseudonym = keccak256(
  companyScopeSalt || polisSub || "cofferdam-company-pseudonym-v1"
)
```

`companyScopeSalt` is held by the `cofferdam-vault` Worker for as
long as the company exists — keyed by the global (domain-anchored)
`companyAnchor` (rev-7.4), so it is the same secret across every consumer
that serves the company (§3.4 of this doc — the scope-salt lifecycle is
otherwise the same as for sovereign per-app pseudonyms).
`polisSub` was stable for the worker at their former employer and
is preserved in the historical SCIM event stream
(`ENTERPRISE_MODULE_PLAN.md` §5.5). So the vault can always
**reconstruct the dormant `companyBoundPseudonym` leaf** for any
former worker and prove its inclusion in a historical OrgRoot.

The part that is *not* cryptographic — and this matters — is
linking "the human holding this fresh Self nullifier" to "the
human behind that dormant leaf." At company-bound deploy time the
worker had **no** Self nullifier, so no on-chain binding between
`polisSub` and any nullifier was ever recorded. There is nothing
to re-derive. The match is therefore **attester-asserted**, in
exactly the same trust class as the bind attester (§8): the
`cofferdam-attester` Worker compares the Self disclosure
(name + nationality + DOB, selectively disclosed during the R2
prove) against the former employer's HR / SCIM record for that
`polisSub`, and — on a confident match — signs a recovery
authorisation binding *this nullifier* to *this account*. The
on-chain contract does not, and cannot, perform the human-match;
it verifies the attester vouched for it (check `(b)`) and that the
target account's leaf was genuinely enrolled (check `(c)`).

Concretely: a former worker, holding only their personal devices
and a fresh Self.xyz passport scan, can reach `AA-x` because (1)
the vault re-builds the dormant `companyBoundPseudonym` leaf and
its Merkle inclusion proof from `companyScopeSalt + polisSub`, (2)
the attester confirms the Self disclosure matches the HR record
the leaf was minted from, and (3) the account contract verifies
both on-chain before handing over control. The trust assumption
is identical to the one already accepted for the bind path — no
new trusted party is introduced.

#### 3.11.2 The ceremony, end to end

```
┌───────────────────────────────────────────────────────────────────┐
│  R1. Former worker installs Cofferdam RN app (if not already      │
│      installed). Opens "Company Bindings" → "Recover orphaned     │
│      wallet" (UX shipped in cofferdam-app, surfaced via the       │
│      §3.3.4 dashboard banner when ENTERPRISE_MODULE_PLAN's banner │
│      threshold is crossed — i.e. > $100 USDC in a company-bound   │
│      AA whose worker has not Self-bound).                         │
│      ↓                                                            │
│  R2. App walks the standard Self.xyz NFC + Container prove        │
│      (§3 steps 6–7), disclosing name + nationality + DOB.         │
│      Container returns (proof, nullifier, publicInputs,           │
│      disclosedAttrs).                                             │
│      ↓                                                            │
│  R3. App calls cofferdam-vault recovery endpoint:                 │
│        POST /v1/recover-orphaned-wallet                           │
│        { employerRef, nullifier, proof, publicInputs,            │
│          disclosedAttrs }                                         │
│      Vault, holding companyScopeSalt + the historical SCIM        │
│      stream, enumerates candidate dormant leaves for employerRef  │
│      and matches the disclosed (name, nationality, DOB) against   │
│      the HR record behind each leaf's polisSub. On a confident    │
│      match it identifies the target leaf:                         │
│        companyBoundPseudonym = keccak256(                         │
│          companyScopeSalt || polisSub ||                          │
│          "cofferdam-company-pseudonym-v1")                        │
│      NOTE: this is an attester-asserted human match, NOT a        │
│      cryptographic re-derivation — see §3.11.1.                   │
│      ↓                                                            │
│  R4. On a confident match, attester signs a recovery message      │
│      and Worker returns:                                          │
│        {                                                          │
│          aaAddress: AA-x,                                         │
│          companyBoundPseudonym: <the dormant leaf value>,        │
│          orgRoot: <historical generation the leaf was in>,       │
│          merkleProof: <inclusion proof of the leaf under orgRoot>,│
│          attesterSignature: <attester sig over                    │
│            (AA-x, nullifier, companyBoundPseudonym, orgRoot)>     │
│        }                                                          │
│      ↓                                                            │
│  R5. App submits the recovery tx, paymaster-sponsored:            │
│        AA-x.recoverWithSelf(                                      │
│          { nullifier, proof, publicInputs, attester, attesterSig,│
│            employerRef, companyBoundPseudonym, orgRoot,           │
│            merkleProof }                                          │
│        )                                                          │
│      Contract:                                                    │
│        (a) Groth16 verify of the proof — REAL check.              │
│        (b) attester allowlist (SelfAttesterRegistry) + signature  │
│            over (AA-x, nullifier, companyBoundPseudonym, orgRoot).│
│            THIS is where the human-match is vouched for.          │
│        (c) Merkle inclusion: companyBoundPseudonym is under       │
│            orgRoot, and orgRoot is a generation the tenant        │
│            genuinely emitted (CofferdamCorporateRegistry).        │
│        (d) Replaces ALL authority modules with                    │
│            SelfNullifierAuthority(nullifier). PolisSessionAuthority│
│            is removed (the IdP can never again issue a valid      │
│            token; keeping the module would be dead weight), and   │
│            the nullifier is bound in NullifierRegistry in the     │
│            same tx. The replacement is atomic — failure of any    │
│            check reverts the whole thing.                         │
│      ↓                                                            │
│  R6. Recovery complete. AA-x is now under exclusive control of    │
│      the worker's sovereign identity. They can move the USDC,     │
│      off-ramp via §3.5 step 3 of cofferdam-app/ARCHITECTURE.md,   │
│      or hold. The Merkle org tree continues to show AA-x at the   │
│      worker's former role *as a historical attestation* — that's │
│      a feature, not a bug; future witness queries return correct │
│      historical roles for any contract signed prior to            │
│      termination.                                                 │
└───────────────────────────────────────────────────────────────────┘
```

#### 3.11.3 Edge cases this ceremony does NOT cover

`ENTERPRISE_MODULE_PLAN.md` §3.3.4 is honest about the residual
gap. Restated here in SDK terms:

- **Worker held no balance.** The recovery flow is unnecessary;
  the AA just becomes a dead address.
- **Worker held a balance AND cannot pass Self.xyz** (undocumented
  worker with no recoverable national credential). This is the
  only fully-unrecoverable case. Mitigation is *forward-looking*:
  the dashboard banner that fires above the $100 threshold makes
  it visible *before* termination is plausible, giving workers
  agency to bind Self while they still hold valid corporate SSO.
- **Tenant has shut down between worker termination and recovery
  attempt.** The `companyScopeSalt` is still held by
  `cofferdam-vault` (the tenant's existence is independent of
  whether they're still actively serving the dashboard), so this
  case works. We document this explicitly in the operations
  runbook — `companyScopeSalt` rows in the vault are
  **archive-class**, never expired solely on tenant churn.
- **`cofferdam-vault` itself has lost the salt.** Catastrophic
  and out-of-scope. The salts are backed up on the same cadence
  as the `cofferdam-attester` signing key. If we lose either, we
  have a far larger problem than enterprise-orphan recovery.

#### 3.11.4 SDK API surface

```ts
// @cofferdam/sdk-enterprise — packages/enterprise/src/recovery.ts

export interface RecoverOrphanedWalletRequest {
  /** ENS-or-domain of the former employer. */
  employerRef: string
  /** Self.xyz proof produced inline by CofferdamNativeProvider. */
  proof: Hex
  nullifier: Hex
  publicInputs: bigint[]
}

export interface RecoverOrphanedWalletResponse {
  /** The orphaned AA reclaimed. */
  aaAddress: Address
  /** Tx hash of the recoverWithSelf submission. */
  txHash: Hex
  /** USDC balance the worker can now move. */
  reclaimedBalance: bigint
  /** True if the AA was already under sovereign control (idempotent). */
  alreadyRecovered: boolean
}

export async function recoverOrphanedWallet(
  req: RecoverOrphanedWalletRequest,
): Promise<RecoverOrphanedWalletResponse>
```

Lives in `@cofferdam/sdk-enterprise` because the
`employerRef` lookup is enterprise-scoped — the function calls
the `cofferdam-vault` `/v1/recover-orphaned-wallet` endpoint
documented in `ENTERPRISE_MODULE_PLAN.md` §5 (the
`POST /me/recover-orphaned-wallet` route added in the rev-7.1
patch).

#### 3.11.5 The `recoverWithSelf` contract method

The on-chain endpoint that the §3.11.2 R5 step calls. It lives on
the **AA account contract** itself (the Base smart account
deployed at E3 of §3.10), *not* on `NullifierRegistry` — the
nullifier registry binding is unchanged; what `recoverWithSelf`
mutates is the calling account's own authority-module set. The
method is the recovery-path sibling of the §3.10 E7
`addAuthority(SelfNullifierAuthority)` call; the contrast is the
whole point:

| | `addAuthority` (§3.10 E7, happy path) | `recoverWithSelf` (§3.11, orphan path) |
|---|---|---|
| **Precondition** | Worker still employed; active `PolisSessionAuthority` session signs the tx | Worker left; SSO revoked; no valid Polis token exists |
| **Authority caller** | The AA's own `PolisSessionAuthority` | A fresh Self proof + Merkle inclusion proof; no existing authority can sign |
| **Effect on `PolisSessionAuthority`** | Retained (OR semantics — both authorities coexist) | **Removed** (it's dead weight; the IdP can never re-issue) |
| **Effect on `SelfNullifierAuthority`** | Added as a second module | Installed as the *sole* module |
| **Net authority set after** | `{ PolisSession, SelfNullifier }` | `{ SelfNullifier }` |

**Solidity surface** (lives on the account contract — see the
contracts-repo cross-reference note below):

```solidity
// On the AA account contract (rev-7.1 authority-module model).
// The account starts with PolisSessionAuthority installed at E3;
// recoverWithSelf is the no-active-authority escape hatch.

struct RecoverParams {
    bytes32   nullifier;             // Self.xyz nullifier from the fresh prove
    bytes     proof;                 // Groth16 proof bytes
    uint256[] publicInputs;          // Self disclosure public signals
    address   attester;              // Cofferdam attester address (must be allow-listed)
    bytes     attesterSig;           // attester sig over (account, nullifier,
                                     //   companyBoundPseudonym, orgRoot) — vouches the human-match
    bytes32   employerRef;           // bytes32(domain) of the former employer
    bytes32   companyBoundPseudonym; // the dormant leaf value the vault re-built:
                                     //   keccak256(scopeSalt || polisSub || "...pseudonym-v1")
    bytes32   orgRoot;               // historical OrgRoot generation the leaf was in
    bytes32[] merkleProof;           // inclusion proof of companyBoundPseudonym under orgRoot
}

/// @notice Reclaim an orphaned company-bound AA after SSO revocation
///         by proving sovereign Self identity matches the dormant leaf.
/// @dev    Callable WITHOUT any existing authority signature — that's
///         the point; the worker has lost SSO. Authorisation is the
///         Groth16 proof + attester allow-list + Merkle inclusion.
///         Atomic: any failed check reverts the entire call.
function recoverWithSelf(RecoverParams calldata p) external;
```

**On-chain checks (all must pass; the call is atomic):**

1. **`(a)` Groth16 proof verification.** `Verifier_vc_and_disclose`
   (the same verifier `NullifierRegistry.bindNullifier` uses)
   checks `p.proof` against `p.publicInputs`. A REAL ZK check, not
   a trusted attestation. Reverts `InvalidProof`.
2. **`(b)` Attester allow-list + human-match vouch.**
   `SelfAttesterRegistry.isAuthorized(p.attester)` must be true,
   and `p.attesterSig` must be a valid signature by `p.attester`
   over `keccak256(address(this) || p.nullifier ||
   p.companyBoundPseudonym || p.orgRoot)`. **This is the step that
   carries the human-match** — the attester signs only after the
   `cofferdam-vault` Worker has matched the Self disclosure
   (name / nationality / DOB) against the HR record behind the
   leaf's `polisSub` (§3.11.1). The contract trusts this assertion
   in the same way the bind path trusts the attester; it does not
   re-derive the link itself. Reverts `UnauthorizedAttester` /
   `BadAttesterSig`.
3. **`(c)` Leaf Merkle inclusion.** `p.companyBoundPseudonym` must
   verify under `p.orgRoot` via `p.merkleProof`, and `p.orgRoot`
   must be a generation that `CofferdamCorporateRegistry` actually
   emitted for `p.employerRef` (checked against the registry's
   historical-root set — see `ENTERPRISE_MODULE_PLAN.md` §6.B).
   This proves the target account's leaf was a *genuinely
   enrolled* company-bound identity, not a fabricated one — it
   stops an attacker from pointing recovery at an arbitrary
   address. Reverts `LeafNotAnchored`.
4. **`(d)` Authority replacement.** On all checks passing, the
   account **replaces** its entire authority-module set with a
   single `SelfNullifierAuthority(p.nullifier)`. Any existing
   `PolisSessionAuthority` is removed. After this call, only the
   sovereign Self nullifier can sign for the account.

**Idempotency.** If the account's sole authority is already
`SelfNullifierAuthority(p.nullifier)` (e.g. an RPC retry after a
stuck tx), the call is a no-op success — the SDK surfaces this as
`alreadyRecovered: true` (§3.11.4). If the account is bound to a
*different* nullifier, reverts `AccountUnderDifferentSovereign`
(should be impossible — Self nullifiers are deterministic per
passport).

**Events:**

```solidity
event WalletRecoveredWithSelf(
    address indexed account,
    bytes32 indexed nullifier,
    bytes32 indexed employerRef,
    uint64  recoveredAt
);
event AuthorityReplaced(
    address indexed account,
    bytes32 removed,   // keccak256("PolisSessionAuthority")
    bytes32 installed  // keccak256("SelfNullifierAuthority")
);
```

**Paymaster sponsorship + anti-abuse.** `recoverWithSelf` is
paymaster-sponsored so the orphaned worker needs no ETH (they may
have only USDC in the dead wallet). Anti-abuse mirrors the
`bindNullifier` policy in `contracts/WEB3_CONVERSION.md` §8:
**one successful `recoverWithSelf` per account lifetime; 3 failed
attempts per IP per day.** The attack surface is bounded by two
independent gates: an attacker cannot point recovery at an
arbitrary address (check `(c)` requires the target's
`companyBoundPseudonym` leaf to be Merkle-anchored in a real
historical OrgRoot Cofferdam emitted), *and* cannot impersonate a
former worker (check `(b)` requires the `cofferdam-attester` to
have vouched for the Self-disclosure ↔ HR-record human-match,
which a Self proof from the wrong human fails). The weakest link
is therefore the attester's off-chain matching quality — the same
trust assumption already accepted for the bind path (§8) — not a
forgeable on-chain primitive. The matching policy (what
confidence threshold, what manual-review escalation for fuzzy
name matches) is an operational concern documented in the
`cofferdam-vault` runbook, not pinned in the contract.

**Why it lives on the account, not the registry.** The nullifier
↔ account binding in `NullifierRegistry` is *append-only and
one-shot* by design (§3 idempotency). `recoverWithSelf` does not
touch that binding — an orphaned company-bound AA was never bound
in `NullifierRegistry` (it had no nullifier; its authority was
`PolisSessionAuthority`). Recovery *establishes* the nullifier
binding for the first time as a side effect: after check `(a)`
passes, the account also calls
`NullifierRegistry.bindNullifier(...)` for itself in the same tx
(it now has a real nullifier), so post-recovery the account is a
fully-ordinary sovereign account indistinguishable from one that
took the §3 sovereign-first path.

> **Contracts-repo cross-reference.** The AA account contract that
> hosts `recoverWithSelf` (and `addAuthority` / `removeAuthority` /
> the `PolisSessionAuthority` + `SelfNullifierAuthority` modules)
> is the rev-7.1 generalisation of the passkey-validator stub
> sketched at `contracts/WEB3_CONVERSION.md` §3.1
> (`CofferdamAccountValidator.sol`). That contract is not yet
> implemented; this subsection is its authoritative method-level
> design spec until the Solidity lands under
> `contracts/contracts/v1/base/`. See
> `contracts/contracts/v1/base/README.md` → *Open items* for the
> implementation tracking entry.

### 3.12 Consumer password→passkey migration (rev-7.7)

§3.10/§3.11 cover the *enterprise* (managed low-tier) path. This subsection
covers the **consumer** path: an app — OffshoreSync (`react-server`) is the
Tier-1 reference — that today authenticates users by **local password** or
**Google/Apple OAuth** (`react-server/routes/auth.js`) and is wiring the SDK
for account deployment. The whole point of passkeys is to remove a leakable
shared secret from the database, so this flow converts those old-style logins
into a **high-tier device passkey on an AA**, under the §2.5 ratchet.

The UX target is the Uniswap in-app-wallet model (secure a wallet in a few
taps with FaceID/TouchID/passkey; attach more login methods later) — but on
**Base ERC-4337 + Secure-Enclave passkey instead of Privy MPC**, and
with **no seed phrase** (recovery is §2.5.3, never seed export).

```
┌───────────────────────────────────────────────────────────────────┐
│  C1. Existing user signs in with their CURRENT method (local       │
│      password, or Google/Apple). authProvider ∈ {'local',          │
│      'google', 'apple'}; wallet.migrationStatus = 'pending'        │
│      (WEB3_CONVERSION.md §5.4).                                    │
│      ↓                                                            │
│  C2. SDK signIn() finds no AA for this user. It does NOT deploy    │
│      yet — the AA stays COUNTERFACTUAL (no funds, no on-chain      │
│      authority) so a leaked credential has nothing to attack       │
│      during the pending window. (Contrast §3.10 E3, where the      │
│      employer-funded AA deploys early under the centrally-          │
│      revocable PolisSessionAuthority.)                            │
│      ↓                                                            │
│  C3. SDK offers the passkey upgrade, picking a lane by capability: │
│       (a) DEFAULT — QR handoff to the Cofferdam RN app             │
│           (CofferdamAppProvider, §2.2): the hardware-bound,        │
│           air-gapped Secure-Enclave passkey is the canonical,      │
│           portable signer.                                        │
│       (b) OPT-IN per consumer — an in-browser platform-            │
│           authenticator passkey, first-party origin only (§2.3),   │
│           accepting that it is origin-bound / non-portable.        │
│      If hardware is not passkey-capable, or the in-browser passkey │
│      is not reliable for the use case, lane (a) is mandatory.      │
│      ↓                                                            │
│  C4. In the SAME session, the low-tier authority authorises the    │
│      first-passkey enrolment + counterfactual deploy in one flow:  │
│        deploy({ validator: CofferdamAccountValidator,          │
│                 bootstrap:  <password | oauth session authority>,  │
│                 initialPasskey: <P-256 pubkey> })                 │
│      The validator registers the passkey as HIGH tier and fires    │
│      the §2.5.2 ratchet: the low-tier authority is permanently     │
│      locked out of add/remove-authority.                          │
│      ↓                                                            │
│  C5. SDK prompts a BACKUP (§2.5.3): add a second device passkey    │
│      and/or bind Self.xyz. Without it a single-device user has no  │
│      recovery — surfaced honestly here, not at loss.              │
│      ↓                                                            │
│  C6. Server flips authProvider → 'base-passkey' and             │
│      wallet.migrationStatus → 'enrolled'. The password is demoted  │
│      to a disabled/break-glass credential per the WEB3_CONVERSION  │
│      §7 release ladder (legacy → passkey-default → disabled).    │
└───────────────────────────────────────────────────────────────────┘
```

**Properties of this flow:**

- **Counterfactual until the high-tier key exists.** The window in which only
  an untrusted low-tier authority guards the AA collapses to the single
  enrolment session; there is nothing fundable to steal before then.
- **Per-user and resumable.** `wallet.migrationStatus` (`pending` →
  `enrolled` | `declined`) drives the WEB3_CONVERSION §7 release ladder. A
  `pending`/`declined` user keeps a counterfactual AA and is re-prompted; any
  funds that arrive wait at the counterfactual address.
- **Priority by authProvider.** `local` (password) is the leak surface and
  migrates first; `google`/`apple` carry no stored secret on our side but
  still need an AA + high-tier passkey, so they take the same path with lower
  urgency. New users are passkey-first and never hold a password.
- **Reconciliation is NOT triggered here.** Multi-device reconciliation (§7;
  `ARCHITECTURE.md` §3.6) fires **only** on a Self.xyz nullifier collision,
  never from a password/social/SSO login. A migrated user who later QR-signs
  with their RN-app passkey simply makes one passkey an authority on a second
  AA — that is not a merge. Reconciliation stays off the migration path.

## 4. Cloudflare Container Self prover — image specification

The single piece of new infrastructure. Everything else is contract
code or SDK code.

### 4.1 What it is

A Docker image, deployed on Cloudflare Containers, that hosts the
Self.xyz open-source prover library and exposes one HTTP endpoint:

```
POST https://prover.cofferdam.xyz/v1/prove
  Headers:
    Authorization: Bearer <session-bound JWT from cofferdam-attester>
    Content-Type:  application/octet-stream
  Body:
    Encrypted passport payload (per Self.xyz mobile-sdk wire format)
  Returns: 200
    {
      "proof": "<groth16 hex>",
      "nullifier": "<bytes32 hex>",
      "publicInputs": [...]
    }
```

### 4.2 Image contents

```
cofferdam-prover:1.0.0
├── /app/
│   ├── prover                       # Self.xyz prover libs, pinned commit
│   ├── circuits/                    # Self.xyz circuit artifacts
│   └── server.js                    # thin HTTP wrapper, ~200 lines
├── /srs/                            # ← empty; SRS fetched at warm-start
└── /etc/cofferdam/
    └── image-manifest.json          # for the reproducible-build receipt (§8)
```

The SRS (~hundreds of MB) is **not bundled in the image**. It's
fetched from Cloudflare R2 at warm-start under a content-addressed
key, hash-verified before use. This keeps the image small enough
for fast cold-start and lets us update the SRS (if Self.xyz ships a
circuit revision) without rebuilding the image.

### 4.3 Reproducible build

The Dockerfile pins every input:

```dockerfile
FROM node:22.11.0-bookworm-slim@sha256:<digest>
RUN apt-get install -y --no-install-recommends \
    libsodium23=1.0.18-* \
    && rm -rf /var/lib/apt/lists/*
COPY package-lock.json /app/
RUN cd /app && npm ci --omit=dev
# Self.xyz prover libs — pinned to a known commit
ARG SELF_LIBS_COMMIT=<sha>
RUN git clone https://github.com/selfxyz/self-mobile-sdk /tmp/self \
 && cd /tmp/self && git checkout ${SELF_LIBS_COMMIT} \
 && cp -r dist/* /app/prover/
COPY server.js /app/
COPY image-manifest.json /etc/cofferdam/
ENTRYPOINT ["node", "/app/server.js"]
```

The resulting image SHA is recorded in
`@/Users/hoff/OffshoreSync/cofferdam-sdk/IDENTITY_LAYER_DESIGN.md` (this doc, in
the changelog), in the on-chain `SelfAttesterRegistry` metadata
URI, and in the production deploy manifest. **This image SHA is the
receipt that Phase γ TEE-attestation upgrade will use** — see §8.

### 4.4 Runtime configuration on Cloudflare

- **Memory.** 2 GB per instance (Groth16 prove + SRS in RAM).
- **CPU.** Default Cloudflare Container CPU envelope; one prove ≈
  5–10 seconds CPU.
- **Concurrency.** 1 prove per instance per request (no shared
  state). Cloudflare's autoscaling spawns parallel instances on
  demand. Scales to zero between proves.
- **Cold-start tolerance.** ~3–8 seconds for first instance after
  scale-to-zero; the user already sees a "verifying your
  passport…" UX in the RN app so latency is human-scale anyway.

## 5. Privacy-preserving parameters

The full list of container hardening constraints. Each is auditable
post-deploy:

| Parameter | Setting | Rationale |
|---|---|---|
| **Persistent storage** | None. Container filesystem is ephemeral. | No proof bytes / no passport data survives across requests. |
| **Egress allowlist** | (a) Cloudflare R2 public endpoint for SRS fetch (content-addressed, read-only); (b) `cofferdam-attester` Worker over Cloudflare's private network; (c) Base RPC (read-only, for any contract sanity checks). **No other outbound.** | Forbids exfil to Self.xyz hosted relay or any third party; explicit positive allowlist. |
| **Inbound** | Cloudflare Workers binding only — no public ingress IP. | The HTTP `/v1/prove` endpoint is reached only through the cofferdam-attester Worker; never directly. |
| **Stdout/stderr** | Disabled in production. Structured error reporting to a separate audit channel; errors carry no PII / no proof bytes / no nullifier. | Defense-in-depth against accidental log capture of sensitive intermediate state. |
| **Memory hygiene** | Prover process calls `wipe()` on the witness vector + intermediate field-element buffers after each proof. | Standard cryptographic hygiene; mitigates a memory-disclosure bug in CF's substrate. |
| **Reproducible build** | Locked Dockerfile + pinned Node toolchain + pinned Self libs commit + pinned SRS hash. Image SHA tracked + published. | Open-source auditability: any researcher can reproduce the image and verify the SHA. Also serves as receipt for optional Phase γ TEE-attestation upgrade (§8). |
| **Stateless** | Multiple parallel instances OK; no shared state, no shared filesystem. | Horizontal scaling without coordination. |
| **TTL** | Cloudflare's default (scale-to-zero idle timeout). | Idle instances don't sit accumulating state. |
| **Time-bounded sessions** | Each `/v1/prove` call requires a fresh JWT from cofferdam-attester (60-second TTL). | Prevents replay; binds the prove to a specific signed bind-message. |

## 6. Workers AI `parseDocument` primitive (Vault parser)

The Vault primitive moves from a prior spec that considered a TEE-backed
Gemini Vision to **Workers AI + Gemma-4-26B-A4B-IT** (`@cf/google/gemma-4-26b-a4b-it`).
Same model family OffshoreSync's `syncai` already trusts (Gemini 3
distillation lineage), 4B active params on inference, native
vision, $0.10/M tokens against Cloudflare edge GPUs.

The SDK ships `parseDocument` as a generic primitive. The consumer
brings the prompt + schema; the SDK provides the plumbing.

### 6.1 Public API

```ts
// @cofferdam/sdk-vault — packages/vault/src/parseDocument.ts

export type WorkersAIVisionModel =
  | 'gemma-4-26b-a4b-it'     // default; instruction-tuned, Gemini-3 lineage
  | 'llama-3.2-vision-11b'   // optional cheap fallback
  | 'llama-3.2-vision-90b'   // optional higher-fidelity fallback
  | (string & {})            // forward-compat for any CF-published vision model

export interface ParseDocumentRequest {
  /** Raw bytes of the document. PDF or image. */
  buffer: Buffer
  /** MIME type — used to choose the model's multimodal input shape. */
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'
  /** Consumer-supplied prompt. Maritime, medical, construction, anything. */
  prompt: string
  /** Optional Zod schema. If supplied, output is parsed + validated. */
  schema?: ZodSchema
  /** Model selection. Defaults to 'gemma-4-26b-a4b-it'. */
  model?: WorkersAIVisionModel
  /** Scope metadata for audit + Tier 2 metering — no PII. */
  scope?: {
    tenantRef?: string
    userRef?: string
    documentKind?: string  // e.g. 'maritime_certificate', 'medical_license'
  }
}

export interface ParseDocumentResponse<T = unknown> {
  /** Schema-validated structured output (or raw JSON if no schema). */
  data: T
  /** Raw model output text, preserved for debugging schema-validation failures. */
  raw: string
  /** Model-reported confidence [0, 1], normalised. */
  confidence: number
  /** Token accounting for Tier 2 metered usage billing. */
  tokensIn: number
  tokensOut: number
  /** Cost in USD cents, computed from the per-model rate card. */
  costUsdCents: number
  /** Resolved model name (after fallback resolution). */
  modelVersion: string
  /** ISO timestamp. */
  parsedAt: string
}

export async function parseDocument<T>(
  req: ParseDocumentRequest,
): Promise<ParseDocumentResponse<T>>
```

### 6.2 What the SDK does

1. Marshals the multimodal payload into the Workers AI binding's
   expected shape: `{ messages: [{ role: 'user', content: [text +
   image] }] }`.
2. Calls the chosen Workers AI model (`@cf/google/gemma-4-26b-a4b-it`
   by default).
3. Robust JSON extraction — strips markdown fences, handles
   model-occasional preamble, recovers gracefully from "almost
   JSON" with the same `parseJsonResponse` pattern OffshoreSync's
   `syncai/geminiService.js` already uses.
4. Optional schema validation via Zod. On validation failure,
   returns structured error with the raw output preserved.
5. Surfaces `tokensIn` / `tokensOut` / `costUsdCents` so Tier 2
   integrators see metered usage line up with
   `financial/REVENUE_MODEL.md` §8.3.
6. Audit-logs `scope.tenantRef + scope.userRef + scope.documentKind`
   (no PII, no document content, no extracted fields).

### 6.3 What the SDK explicitly does **not** do

- Does not bundle maritime prompts. Does not know what an STCW is.
- Does not bundle medical, construction, or any vertical prompts.
- Does not enforce a global output schema.
- Does not validate that the parsed data is "correct" — that's the
  consumer's job (and ultimately the user's, via the
  user-confirmation review pattern OffshoreSync renders in its
  Certificate Wallet UI).

The maritime parsing intelligence (STCW disambiguation, NOGEPA
Module 2.7, Brazilian TICB vs OPITO LB-COX, NR-10/33/34/35, etc.)
stays in `react-server/services/syncai/geminiService.js` under
OffshoreSync's existing licence. `syncai` becomes a consumer of
this SDK primitive — exactly one call swap (see
`@/Users/hoff/OffshoreSync/STRATEGY.md` §2.3 and the analogous
abstraction in `@/Users/hoff/OffshoreSync/cofferdam-sdk/IDENTITY_LAYER_DESIGN.md` §6.1
above):

```js
// syncai/geminiService.js — only line that changes:
const { data: result } = await parseDocument({
  buffer,
  mimeType,
  prompt,            // unchanged — the full maritime prompt
  schema: maritimeCertificateSchema,
  scope: { tenantRef, userRef, documentKind: 'maritime_certificate' },
})
```

Same prompt, same shape, lower cost, edge-local latency.

## 7. Multi-device reconciliation primitives

Per `@/Users/hoff/OffshoreSync/cofferdam-app/ARCHITECTURE.md` §3.6 — the full
engineering spec lives there; this section is the SDK-side
implementation manifest.

### 7.1 The primitives T1.1 must ship

| Primitive | File | What it does |
|---|---|---|
| `bind.ts` pre-flight | `cofferdam-sdk/packages/core/src/identity/bind.ts` | Pre-flight `nullifierToAccount(n)` read on Base *before* submitting the v2 bind tx — catches the collision case without wasting gas. Replaces the §3.6.3 cross-chain subtlety with a single-chain pre-flight (cheaper + simpler). |
| `NullifierAlreadyBoundError` | `cofferdam-sdk/packages/core/src/errors.ts` | Typed error surfaced when pre-flight or contract revert indicates the nullifier is bound to a different account. Triggers the reconciliation ceremony UI. |
| `AccountAlreadyBoundError` | same | Typed error when the account already has a different nullifier (shouldn't happen in practice — caught for debug visibility). |
| `loadCanonicalAA(recoveryEmail)` | `cofferdam-sdk/packages/core/src/identity/recovery.ts` | Warm-recovery resolver for §3.6.6 R3 — orphan device looks up the canonical AA address by recovery email *before* attempting a re-bind that would deterministically collide. |
| QR-encoded passkey-handoff payload format | `cofferdam-sdk/packages/core/src/identity/handoff.ts` + `packages/react-native/src/qr.ts` | The §3.6.4 Step A on-the-wire format for "canonical device → orphan device" passkey handoff via in-room QR. Includes UserOp template, nonce, AA address, and a freshness timestamp. |

### 7.2 What the ceremony UX is **not** in scope of T1.1

The ceremony **screens** (pre-flight collision detect, Step A QR
render + biometric approval on canonical device, Step C revoke,
Step D sweep) all live in **T1.2 — Cofferdam React Native app
shell**. T1.1 ships the *primitives*; T1.2 wires them into screens.
This split is intentional — keeps T1.1's scope tight and lets the
RN app surface evolve independently.

## 8. Trust model + optional Phase γ TEE-attestation upgrade

The current trust model is **"trust the open-source, reproducibly-built
Cofferdam Cloudflare backend"**. Concretely:

- Cofferdam controls a SelfAttester key — registered on-chain in
  `SelfAttesterRegistry`.
- The key lives as a Cloudflare-managed secret, accessed only by
  the `cofferdam-attester` Worker.
- The Container generates the proof; the Worker signs the bind
  message; the contract verifies (a) the Groth16 proof is valid
  and (b) the attester is on the allowlist.

What we are **not** doing today: producing a cryptographic
attestation that the proof was generated inside a specific
hardware-bound TEE. AWS Nitro Enclave + Amazon-root-CA + PCR
whitelist would give us that; it remains an **optional** Phase γ
hardening, not a current dependency. The open-source + reproducible
build + operational hardening posture (§5) is the current trust
boundary.

### 8.1 The receipt that makes the upgrade clean

Every production-deployed `cofferdam-prover` Container image has a
**published SHA**. The image SHA is recorded in three places:

1. This doc's changelog (immutable history).
2. The on-chain `SelfAttesterRegistry` metadata URI for the
   currently-registered attester.
3. The production deploy manifest at
   `infra/cloudflare-prover/manifest.json`.

If we later upgrade to formal TEE attestation (Phase γ in
`@/Users/hoff/OffshoreSync/TODO.md`), the migration is:

1. Build the same `cofferdam-prover` image targeting the new TEE
   substrate (Cloudflare's confidential-compute primitive if it
   ships; or AWS Nitro Enclave; or whatever else looks credible
   then). **The image inputs do not change** — same Self libs, same
   server, same SRS handling. Only the *substrate* changes. This is
   a pure operational upgrade with no code or contract changes.
2. Compute the new image's SHA. Compute the matching attestation
   chain (PCR whitelist, attestation document signing key, etc.).
3. Register the new attester via `SelfAttesterRegistry.addAttester(
   newAttesterAddress, newMetadataURI)`.
4. Cut traffic over from old attester to new.
5. After a cooldown window with zero rebinds against the old
   attester, call `SelfAttesterRegistry.removeAttester(
   oldAttesterAddress)`.

**Nothing on-chain changes besides the attester roster.** Every
existing bind stays valid (the proofs are still cryptographically
verified). New binds go through the upgraded path.

This is why we are willing to accept the trust degradation for α/β:
the migration cost is bounded and pre-paid by the reproducible-
build discipline we are imposing on the Container image today.

### 8.2 What we will not promise pre-Phase γ

- Cryptographic guarantee that the proof was generated inside an
  unmodified Container image (we promise the image *can* be
  reproduced from the published Dockerfile + pinned inputs, but
  not that *this specific proof* came from that image).
- Resistance to a Cloudflare-internal attacker with access to the
  attester secret (mitigation: the secret is rotated quarterly +
  on incident; on-chain `removeAttester` is the kill-switch).
- Resistance to a Cloudflare-internal attacker with access to the
  Container substrate itself (this is the gap formal TEE
  attestation closes).

Pre-Phase γ users get **on-chain verifiable proof of personhood +
narrow trust in Cofferdam-the-company's operational discipline**.
Post-Phase γ they get **on-chain verifiable proof of personhood +
cryptographic proof of execution environment**. We will be explicit
about which one is live at any given time.

## 9. What this doc deliberately does not specify

Out-of-scope items, with pointers to where they *are* spec'd:

| Topic | Where |
|---|---|
| Recurring escrow contract design (settlePeriod cron, leave-pay accrual) | `@/Users/hoff/OffshoreSync/contracts/contracts/v1/base/RECURRING_ESCROW_DESIGN.md` |
| Witness delegation registry (industry-agnostic `witnessKind` bytes32) | `@/Users/hoff/OffshoreSync/ENTERPRISE_MODULE_PLAN.md` §6.A + §6.B |
| Per-tenant pseudonym derivation (HKDF-mediated nullifier → per-tenant ID) | `@/Users/hoff/OffshoreSync/ENTERPRISE_MODULE_PLAN.md` §5 (enterprise architecture) + `@/Users/hoff/OffshoreSync/STRATEGY.md` §5 (sovereign-vs-enterprise resolution) |
| Pricing tiers / take rates / TAM | `@/Users/hoff/OffshoreSync/financial/REVENUE_MODEL.md` §8 + §9 + §10 |
| Strategic vertical-pilot framing | `@/Users/hoff/OffshoreSync/STRATEGY.md` |
| Companion-app feature surface (messaging, vault, payments) | `@/Users/hoff/OffshoreSync/cofferdam-app/ARCHITECTURE.md` §4 |
| Phase γ tokenomics (deferred) | `@/Users/hoff/OffshoreSync/financial/REVENUE_MODEL.md` §7.6 + `@/Users/hoff/OffshoreSync/TODO.md` ⚪ Phase γ |

## 10. Build + test plan

### 10.1 Unit tests

Every primitive added in T1.1 ships with unit tests:

- `CofferdamNativeProvider` — mocked Secure Enclave + Base RPC;
  test signIn / passkey signing / AA tx flow / passport bind
  happy path + every typed error.
- `CofferdamAppProvider` — mocked deep-link round-trip + Worker
  session exchange; test the SignInResponse shape parity with the
  native provider.
- `parseDocument` — mocked Workers AI binding; test prompt
  marshalling + JSON extraction + Zod validation + token
  accounting + audit-log shape.
- `bind.ts` pre-flight + reconciliation primitives — mocked
  contract reads; test the four §3.6 race conditions; test the
  three-deploy fan-in cap (§3.6.5).

### 10.2 Integration tests

End-to-end against Base Sepolia + a Cloudflare Container
deployment of `cofferdam-prover` pointing at a published test
build:

- Fresh signup → passkey → AA deploy → SignIn returns
  `verified: false`.
- Same user → passport prove (synthetic test passport) → bind →
  SignIn returns `verified: true` + correct claims.
- Multi-device add: second device → existing AA → addPasskey path
  → passkey count = 2.
- Multi-device reconciliation: orphan device → pre-flight catches
  collision → renders reconciliation prompt (asserted in
  cofferdam-sdk; the actual UI ships in T1.2).
- Vault round-trip: upload PDF → `parseDocument` → user-
  confirmation review → store in R2 + index in D1.

### 10.3 E2E recordings + demo material

For T1.4 (`UX activation across all consumers` per TODO):

- Recruiter signing flow from web via `CofferdamAppProvider`
  deep-link.
- Worker passport bind from RN app.
- Vault credential upload + parse + confirm.
- Multi-device add (existing-device approval path).
- Multi-device reconciliation (pre-flight collision path).

Each captured as a 60–90 second screen recording for partner /
investor demos + for the inevitable replay-debugging when something
breaks in the field.

---

## Change log

- **2026-07-04 — Embedded consumer passkey provider (§2.6).**
  Adds `CofferdamEmbeddedProvider` + NEW `@cofferdam/sdk-capacitor`:
  natively-wrapped consumers (Capacitor OffshoreSync first)
  perform real `cofferdam.xyz` passkey ceremonies via OS APIs
  (`ASAuthorizationController` / `CredentialManager`) under the
  AASA + assetlinks **association registry** — never in-WebView
  WebAuthn (doubly impossible: WKWebView restriction + `localhost`
  origin vs RP ID). Ceremony injects through the existing
  `WebAuthnAuthenticator` seam; contracts + core SDK unchanged.
  Locks `rpId = cofferdam.xyz` permanently; records the
  enrolment-only root-ceremony policy (day-to-day = `csa1:`
  attestations, plane-enforced); defines the three-step fallback
  ladder ending at the hosted ceremony page `id.cofferdam.xyz`
  (needed for the pure-web PWA regardless). §2.3's "cross-app
  passkey sharing is not a thing" refined — it now holds only for
  pure-browser origins. §2.6.1 adds the four-provider mapping
  table. Tracked as T1.5 in `TODO.md`; not T1.1 scope, not
  mainnet-gating.
- **2026-06-01 — rev 7.1 alignment patch.** Extends the doc to
  cover the two-tier identity binding introduced by
  `@/Users/hoff/OffshoreSync/ENTERPRISE_MODULE_PLAN.md` §3.3.
  Added: §2.4 `CofferdamEnterpriseProvider` (a third provider
  variant whose authority root is a Polis SSO ID-token, not a
  device passkey — used by `react-enterprise/` to bootstrap an
  AA on first SSO sign-in without any Self.xyz dependency);
  §2.4.1 *Why three providers and not two* (justification for the
  new variant + a one-glance mapping of provider → authority root
  → onboarding event); §3.10 *The enterprise-flavoured bind flow*
  (the E1–E9 sequence: Polis sign-in → company-bound AA deploy →
  later opt-in Self-bind via `AA.addAuthority(SelfNullifierAuthority)`
  with OR semantics, with the pseudonym swap in the Merkle leaf
  but the AA address stable); §3.11 *Post-employment Self-bind
  recovery ceremony* (the R1–R6 sequence for reclaiming an
  orphaned company-bound AA after SSO revocation, using an
  attester-vouched human-match + Merkle inclusion of the dormant
  company-bound pseudonym leaf in a historical OrgRoot + a fresh
  Self.xyz proof to atomically replace `PolisSessionAuthority`
  with `SelfNullifierAuthority`); §3.11.3 honest edge-case list
  (the only fully-unrecoverable case is worker-held-balance + no
  Self.xyz credential); §3.11.4 SDK API surface
  (`recoverOrphanedWallet(...)` in `@cofferdam/sdk-enterprise`);
  §3.11.5 the `recoverWithSelf` **contract-method spec** — full
  Solidity surface (`RecoverParams` struct + signature), the four
  atomic on-chain checks (Groth16 verify, attester allow-list +
  human-match vouch, company-bound-pseudonym-leaf Merkle
  inclusion, authority replacement),
  idempotency, events (`WalletRecoveredWithSelf` /
  `AuthorityReplaced`), paymaster-sponsorship + anti-abuse policy,
  and a contrast table against the §3.10 E7 `addAuthority`
  happy-path call. The spec is authoritative for the AA-account
  contract until the Solidity lands under
  `contracts/contracts/v1/base/` (tracked in that dir's README
  *Open items*). New typed error `AuthorityAlreadyBoundError`
  added to the SDK core errors list. Header front-matter status block adds a
  rev-7.1 paragraph cross-linking the alignment context.
  Nothing changes in §4 (Container spec) onward — the Container,
  the privacy parameters, `parseDocument`, the multi-device
  primitives, and the trust model are all stack-decision
  invariants that the enterprise variant inherits without
  modification. The §3.10 + §3.11 flows reuse the *exact* §3
  Container + attester pipeline; the only delta is which AA is
  being targeted by the bind tx and which authority module the
  tx installs.
- **2026-05-30 — rev 1 (initial).** First write of the T1.1
  design doc. Captures the rev-6 stack decision: v2 on-ZKSync via
  Cloudflare Container Self prover, Workers AI Gemma-4-26B-A4B for
  Vault, no LayerZero on the critical path, no AWS dependency. The
  contracts in `contracts/contracts/v2/self/` already exist and
  are audited; T1.1 wires them up to the off-chain prover + SDK.
