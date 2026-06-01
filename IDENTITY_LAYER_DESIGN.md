# `cofferdam-sdk` Identity Layer — Design (T1.1)

> **Status.** Design spec for `T1.1 — SDK identity layer α-3` per
> `@/Users/hoff/OffshoreSync/TODO.md`. Written first; implementation
> follows this doc.
>
> **Rev-6 (2026-05-30).** This doc supersedes the LayerZero-V2 +
> AWS-Nitro-Enclave narrative in `contracts/WEB3_CONVERSION.md` and
> in earlier versions of `cofferdam-app/ARCHITECTURE.md`. The production
> identity rail is **v2 NullifierRegistry on ZKSync Era**, attested
> by a **Cloudflare Container Self prover**. LayerZero exits the
> critical path entirely; AWS dependencies do not enter it. See
> `@/Users/hoff/OffshoreSync/financial/REVENUE_MODEL.md` §10.1 +
> §11 for the financial implications of this stack decision.

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
reference in production code paths with the real ZKSync Era flow.
The deliverable is **four sub-packages + one Cloudflare service +
one v2 contract deploy**:

| Sub-package / service | Purpose | New? |
|---|---|---|
| `@cofferdam/sdk` (`packages/core`) — provider interfaces, identity primitives | Already exists; receives `CofferdamNativeProvider` + `CofferdamAppProvider` additions | extends existing |
| `@cofferdam/sdk-react-native` (`packages/react-native`) | Native Secure Enclave / StrongBox passkey bridge for the Cofferdam RN app | **NEW** |
| `@cofferdam/sdk-enterprise` (`packages/enterprise`) | Tenant + KYB + Polis SSO + Safe deploy primitives (vertical-agnostic, scoped under T3 in `ENTERPRISE_MODULE_PLAN.md`) | **NEW** (lifted from OffshoreSync's backend per the SDK-first restructure) |
| `@cofferdam/sdk-vault` (`packages/vault`) | Workers AI `parseDocument` primitive — consumer brings prompt + schema | **NEW** |
| Cloudflare Container `cofferdam-prover` | Self.xyz Groth16 prover wrapped in a reproducible-build image | **NEW** |
| `contracts/contracts/v2/self/NullifierRegistry` deploy on ZKSync Era Sepolia + Mainnet | v2 production ingress (replaces the v1 LayerZero+Celo path) | deploy of already-audited code |

Phases (executable in roughly the order listed; ranges overlap by
~30%):

```
Week 0 ─── design doc lock (this doc)
Week 1-2 ─ CofferdamNativeProvider — passkey + Secure Enclave bridge
Week 2-3 ─ CofferdamAppProvider — web deep-link round-trip
Week 3-4 ─ v2 NullifierRegistry deploy on ZKSync Era Sepolia
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
on-chain on ZKSync Era; the passkey is the validator key.

**Responsibilities.**

1. **Account deploy.** First-passkey-on-first-device — call the
   ZKSync Era native AA factory; deploy the smart account with the
   passkey as the sole initial validator (≤3 passkeys per AA
   enforced on-chain by `OffshoreSyncAccountValidator` per
   `cofferdam-app/ARCHITECTURE.md` §3.3).
2. **Passkey signing.** Native WebAuthn ceremony (P-256, ES256
   COSE algorithm). Returns a signature compatible with
   `OffshoreSyncAccountValidator.isValidSignature(hash, signature)`.
3. **AA tx submission.** Wraps the signed UserOp + submits via the
   Cofferdam paymaster (sponsored gas).
4. **Passport prove orchestration.** Coordinates with the
   Cloudflare Container prover (§4) — the RN app sends the
   pre-NFC passport handle to the Container endpoint and receives
   back the Groth16 proof + nullifier; then submits the attester-
   signed `bindNullifier` tx to v2 `NullifierRegistry` on ZKSync.
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
3. **Read-only chain calls.** Direct ZKSync Era RPC for
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
talking to the native provider.

This split also gives us **per-platform paymaster routing** without
the SDK consumer having to know: the native provider pays through
the user's own session-bound paymaster envelope; the web provider
pays through the consumer-app's per-tenant paymaster sub-pool
(Tier 2/3 per `financial/REVENUE_MODEL.md` §8). Same SDK call;
different payer under the hood.

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
│  3. RN app calls ZKSync Era AA factory (paymaster-sponsored):     │
│       deploy({ validator: OffshoreSyncAccountValidator,           │
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
│  8. RN app submits to ZKSync Era v2 NullifierRegistry:            │
│       NullifierRegistry.bindNullifier(                            │
│         account: AA-x,                                            │
│         nullifier: n,                                             │
│         proof: groth16Bytes,                                      │
│         publicInputs: [...],                                      │
│         attester: attesterAddress,                                │
│         attesterSig: attesterSignature                            │
│       )                                                           │
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

- **No LayerZero hop.** One chain. One bind tx.
- **No AWS dependency.** Cloudflare end-to-end.
- **Proof is verified on-chain.** Trust in the attester is narrow
  — the attester confirms "yes, I (Cofferdam Cloudflare backend)
  saw a proof come out of my Container that I'm willing to vouch
  for as freshly-computed." The actual Groth16 validity is checked
  by `Verifier_vc_and_disclose` on ZKSync Era.
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
| **Egress allowlist** | (a) Cloudflare R2 public endpoint for SRS fetch (content-addressed, read-only); (b) `cofferdam-attester` Worker over Cloudflare's private network; (c) ZKSync Era RPC (read-only, for any contract sanity checks). **No other outbound.** | Forbids exfil to Self.xyz hosted relay or any third party; explicit positive allowlist. |
| **Inbound** | Cloudflare Workers binding only — no public ingress IP. | The HTTP `/v1/prove` endpoint is reached only through the cofferdam-attester Worker; never directly. |
| **Stdout/stderr** | Disabled in production. Structured error reporting to a separate audit channel; errors carry no PII / no proof bytes / no nullifier. | Defense-in-depth against accidental log capture of sensitive intermediate state. |
| **Memory hygiene** | Prover process calls `wipe()` on the witness vector + intermediate field-element buffers after each proof. | Standard cryptographic hygiene; mitigates a memory-disclosure bug in CF's substrate. |
| **Reproducible build** | Locked Dockerfile + pinned Node toolchain + pinned Self libs commit + pinned SRS hash. Image SHA tracked + published. | Receipt for future TEE-attestation upgrade (§8). |
| **Stateless** | Multiple parallel instances OK; no shared state, no shared filesystem. | Horizontal scaling without coordination. |
| **TTL** | Cloudflare's default (scale-to-zero idle timeout). | Idle instances don't sit accumulating state. |
| **Time-bounded sessions** | Each `/v1/prove` call requires a fresh JWT from cofferdam-attester (60-second TTL). | Prevents replay; binds the prove to a specific signed bind-message. |

## 6. Workers AI `parseDocument` primitive (Vault parser)

The Vault primitive moves from "TEE-backed Gemini Vision" (prior
spec) to **Workers AI + Gemma-4-26B-A4B-IT** (`@cf/google/gemma-4-26b-a4b-it`).
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
| `bind.ts` pre-flight | `cofferdam-sdk/packages/core/src/identity/bind.ts` | Pre-flight `nullifierToAccount(n)` read on ZKSync Era *before* submitting the v2 bind tx — catches the collision case without wasting gas. Replaces the §3.6.3 "skip the LayerZero hop" subtlety with a single-chain pre-flight (cheaper + simpler). |
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

## 8. Trust model + Phase γ TEE-attestation upgrade path

The current trust model is **"trust the Cofferdam Cloudflare
backend"**. Concretely:

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
whitelist would have given us that; we are deferring it.

### 8.1 The receipt that makes the upgrade clean

Every production-deployed `cofferdam-prover` Container image has a
**published SHA**. The image SHA is recorded in three places:

1. This doc's changelog (immutable history).
2. The on-chain `SelfAttesterRegistry` metadata URI for the
   currently-registered attester.
3. The production deploy manifest at
   `infra/cloudflare-prover/manifest.json`.

When we later upgrade to formal TEE attestation (Phase γ in
`@/Users/hoff/OffshoreSync/TODO.md`), the migration is:

1. Build the same `cofferdam-prover` image targeting the new TEE
   substrate (Cloudflare's confidential-compute primitive if it
   ships; or AWS Nitro Enclave; or whatever else looks credible
   then). **The image inputs do not change** — same Self libs, same
   server, same SRS handling. Only the *substrate* changes.
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
| Recurring escrow contract design (settlePeriod cron, leave-pay accrual) | `@/Users/hoff/OffshoreSync/contracts/contracts/v1/zksync/RECURRING_ESCROW_DESIGN.md` |
| Witness delegation registry (industry-agnostic `witnessKind` bytes32) | `@/Users/hoff/OffshoreSync/ENTERPRISE_MODULE_PLAN.md` §6.A + §6.B |
| Per-tenant pseudonym derivation (TEE-mediated nullifier → per-tenant ID) | `@/Users/hoff/OffshoreSync/ENTERPRISE_MODULE_PLAN.md` §5 (enterprise architecture) + `@/Users/hoff/OffshoreSync/STRATEGY.md` §5 (sovereign-vs-enterprise resolution) |
| Pricing tiers / take rates / TAM | `@/Users/hoff/OffshoreSync/financial/REVENUE_MODEL.md` §8 + §9 + §10 |
| Strategic vertical-pilot framing | `@/Users/hoff/OffshoreSync/STRATEGY.md` |
| Companion-app feature surface (messaging, vault, payments) | `@/Users/hoff/OffshoreSync/cofferdam-app/ARCHITECTURE.md` §4 |
| Phase γ tokenomics (deferred) | `@/Users/hoff/OffshoreSync/financial/REVENUE_MODEL.md` §7.6 + `@/Users/hoff/OffshoreSync/TODO.md` ⚪ Phase γ |

## 10. Build + test plan

### 10.1 Unit tests

Every primitive added in T1.1 ships with unit tests:

- `CofferdamNativeProvider` — mocked Secure Enclave + ZKSync RPC;
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

End-to-end against ZKSync Era Sepolia + a Cloudflare Container
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

- **2026-05-30 — rev 1 (initial).** First write of the T1.1
  design doc. Captures the rev-6 stack decision: v2 on-ZKSync via
  Cloudflare Container Self prover, Workers AI Gemma-4-26B-A4B for
  Vault, no LayerZero on the critical path, no AWS dependency. The
  contracts in `contracts/contracts/v2/self/` already exist and
  are audited; T1.1 wires them up to the off-chain prover + SDK.
