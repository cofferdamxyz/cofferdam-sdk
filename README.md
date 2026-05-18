# cofferdam-sdk

> **Sign in with Cofferdam.** A verified-identity, ZK-proof, on-chain-signing, encrypted-document-sharing primitive for any app.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--alpha-orange.svg)]()
[![Maintained by](https://img.shields.io/badge/maintained%20by-OffshoreSync%20LLC-0a66c2.svg)](https://offshoresync.com)

`cofferdam-sdk` is the developer-facing surface of [Cofferdam](https://github.com/OffshoreSync/Cofferdam) — an open-source Web3 wallet and identity vault for the maritime industry, published by OffshoreSync LLC. The SDK lets any third-party app integrate Cofferdam as a verified-identity provider, an on-chain signing surface, an E2EE messaging backend, and an encrypted-document share target — without the integrating app needing to know anything about ZK proofs, ZKSync Era, LayerZero, or Cloudflare Durable Objects.

> "Sign in with Cofferdam" is to maritime-grade identity what "Sign in with Apple" is to email-grade identity. The user owns their keys. The app gets a verified, sybil-resistant, cryptographically-anchored identity. Nobody hands plaintext data to anyone.

This SDK is **open source from day one**, MIT-licensed, framework-agnostic at the core, with first-class React, React Native, and web bindings. The first published integration is [OffshoreSync](https://offshoresync.com); the SDK is built to work for any vertical, not just maritime.

---

## Table of contents

- [1. What this SDK does](#1-what-this-sdk-does)
- [2. The "Sign in with Cofferdam" primitive](#2-the-sign-in-with-cofferdam-primitive)
- [3. Consumer-app enforcement policies](#3-consumer-app-enforcement-policies)
- [4. API surface](#4-api-surface)
- [5. Security model](#5-security-model)
- [6. OffshoreSync reference integration](#6-offshoresync-reference-integration)
- [7. Pricing, paymaster, and metering](#7-pricing-paymaster-and-metering)
- [8. Installation and platforms](#8-installation-and-platforms)
- [9. Repo layout](#9-repo-layout)
- [10. Versioning + release policy](#10-versioning--release-policy)
- [11. License](#11-license)

---

## 1. What this SDK does

The SDK exposes **five primitives**, each of which delegates the heavy lifting to the Cofferdam mobile app (or, for web, to a Cofferdam-hosted WebAuthn flow + deep link to the mobile app):

1. **Identity** — *"Is this user a verified, sybil-resistant human, and what's their stable identifier?"* Returns a **per-app pseudonym** (`appPseudonym`) — the consumer app's stable user identifier, derived from a Cofferdam-internal nullifier the consumer app never sees (see §5.6 *Privacy invariant*). Also returns a smart-account address on ZKSync Era for chain-relevant operations, a verification status (Self.xyz nullifier-bound or not), and optional selective-disclosure claims (country, age range, OFAC status). **The nullifier itself is never exposed to the consumer app or its server** — two different consumer apps see two different pseudonyms for the same user; a breach of one consumer app cannot be union-correlated with another. **Self verification is value-gated** — the SDK does not require it at sign-in; it triggers Self only when the user touches a feature that genuinely needs it (verified-flavor messaging, contract signing, financial features, verified-context document sharing). See §2.4. The Identity primitive also supports **account linking metadata**: the consumer app supplies its display name + icon + per-user handle, which appears in the user's Cofferdam *Settings → Linked accounts* view.
2. **Signing** — *"Have this user sign this on-chain transaction."* Used for escrow contracts, proof-of-presence check-ins, and any custom contract the integrating app defines.
3. **Documents (Vault)** — *"Store, parse, list, view, and share encrypted documents for this user, scoped to my app."* The Vault is **generic, per-scope, and parser-configurable**: each consumer app registers the document categories it supports and the Gemini Vision schema to apply per category (or *no parser at all* for blob-only storage). OffshoreSync registers `maritime-certificate` with the STCW schema and recreates its existing Certificate Wallet UI on top of the SDK; a P&I-club app registers `claim-form` with a claims schema; a notary app registers raw documents with `parser: 'none'` and nothing is parsed. **Same dual-UI win as messaging** (see primitive #4): consumer apps either build their own document UI on top of the SDK *or* defer entirely to the Cofferdam app's Vault UI via `documents.openInCofferdam(docId)` — both work, pick per-surface. Plaintext never reaches the integrating app's server unless the user explicitly shares it.
4. **Messaging** — *"Establish an E2EE conversation between two of my app's users."* The integrating app supplies the conversation metadata (e.g. match-room ID) and the social context ("these two are mutual friends in my app"); Cofferdam handles the handshake + cryptography. **The SDK can also bridge a handshake on behalf of the consumer app** — if A and B are friends on OffshoreSync but haven't yet handshaken on Cofferdam, A tapping `[Message]` triggers a one-tap mutual handshake using the OffshoreSync friendship as social attestation. Same primitive scales to **group invitations**: pick N users in OffshoreSync, every linked-Cofferdam participant receives a one-tap accept push.
5. **Payments** — *"Open Cofferdam's send-money flow with this recipient + amount pre-filled."* The integrating app never touches funds.

These five primitives are what make Cofferdam useful beyond OffshoreSync. A crewing agency, a P&I club, a port authority, a maritime training school, an offshore equipment leasing platform — any of them — gets a verified-identity + encrypted-document + on-chain-signing primitive for free via the SDK.

---

## 2. The "Sign in with Cofferdam" primitive

### 2.1 What happens under the hood

```
Consumer app calls cofferdam.signIn({ scope, ...policy })
       │
       ▼
1. Open deep-link to Cofferdam app:
   cofferdam://signin?scope=<consumer-app-name>&policy=<json>&return=<consumer-return-uri>
       │
       ▼
2. Cofferdam app checks:
   - Does the user have a passkey? If not, create one (Secure Enclave / StrongBox).
   - Does the user have a Cofferdam account (smart account on ZKSync Era)?
       - If not, RUN account-deploy flow.
       - Account-deploy flow checks the consumer app's policy:
           * policy.enforceSelfBeforeAccount = false (DEFAULT, e.g. OffshoreSync):
             - Deploy smart account immediately after passkey creation.
             - Self verification is optional, can happen later.
           * policy.enforceSelfBeforeAccount = true (STRICT, e.g. a banking app):
             - Run Self.xyz NFC passport flow first.
             - Wait for LayerZero V2 callback confirming nullifier bound on ZKSync Era.
             - ONLY THEN deploy the smart account.
       │
       ▼
3. User approves the sign-in (one-tap, or biometric if previously approved).
       │
       ▼
4. Cofferdam constructs a SignInResponse signed by the user's passkey:
   {
     // Primary identifier — store this as the user's primary key in your DB.
     // Stable across sessions, devices, and passkey rotations.
     // Different from the pseudonym this user has in any other consumer app.
     // Derived as H(scopeSalt[your-app] || nullifier(user) || domain-sep)
     // entirely on the user's device; the nullifier itself never reaches you.
     appPseudonym:         "cd_pseudo_4f8a3b…",

     // ZKSync Era smart-account address. Use this ONLY for chain-relevant
     // operations (receiving payment, verifying on-chain events). Do NOT use
     // it as your primary user key — use appPseudonym for that.
     accountAddress:       "0xab12…",

     verified:             true | false,
     verifiedClaims: {
       country:            "BR",
       olderThan:          18,
       ofacClear:          true,
       proofTimestamp:     1700000000,
     } | null,

     // Per-consumer-app encryption sub-key. Use for any app-specific encryption
     // (e.g. social-flavor conversation E2EE key envelopes).
     scopeKey:             "<derived sub-key, only valid for this consumer app>",

     sessionToken:         "<short-lived JWT-like token for SDK calls>",
     attestation:          "<passkey-signed envelope binding the above>",
   }
       │
       ▼
5. Deep-link back to consumer app's return URI with the SignInResponse.
       │
       ▼
6. Consumer app's SDK verifies the attestation, stores the sessionToken,
   considers the user signed in.
```

### 2.2 Smart-account deploy gating

This is the **single most important policy decision** in the SDK and deserves its own dedicated explanation.

> The ZKSync Era smart account is the **master key**. Every other key in Cofferdam derives from it. We are deliberate about when it gets deployed.

**`enforceSelfBeforeAccount: false`** (DEFAULT, OffshoreSync's policy):
- The smart account is deployed **immediately after passkey creation**.
- The user can sign in to the consumer app, use non-gated features, and complete Self verification at their own pace.
- The consumer app is responsible for gating its own sensitive features behind a `verified === true` check.
- This is the right policy for **social, content, and marketplace apps** where blocking signup on a 5-minute passport scan kills conversion.

**`enforceSelfBeforeAccount: true`** (STRICT):
- The smart account is **NOT deployed** until the Self.xyz Celo verification has happened AND the LayerZero V2 callback has bound the nullifier to the (future) account on ZKSync Era.
- The user cannot sign in to the consumer app at all without a completed Self verification.
- This is the right policy for **regulated apps** — banking, large-value financial flows, government-adjacent services — where the consumer cannot afford an unverified-account state.
- Trade-off: the onboarding flow becomes ~5 minutes (NFC + TEE proof + LZ confirmation), and the user needs an NFC-equipped phone with a valid biometric passport.

The SDK exposes both options as a simple boolean flag on the `signIn` call. **OffshoreSync uses `false`.** A maritime banking app would use `true`.

### 2.3 What the consumer app never receives

- The user's passkey private key (lives in the device's Secure Enclave / StrongBox).
- The user's master key (the smart-account-derived root).
- The user's raw passport data (lives in Self's TEE briefly, then in the device's encrypted vault).
- Any messaging-root-key, vault-root-key, or per-conversation key.
- Plaintext documents.

What the consumer app DOES receive: a verified identifier (`accountAddress`), a sybil-resistance attestation (`verified`), optional selective-disclosure claims (`verifiedClaims`), a per-consumer-app derived sub-key (`scopeKey`) for any consumer-app-specific encryption, and a short-lived `sessionToken` for follow-up SDK calls.

### 2.4 When does the SDK trigger Self verification?

The SDK inherits the canonical policy from **§3.5 of the Cofferdam README** (*Self.xyz verification: gated by value, not at entry*). The default integration is conversion-preserving: passkey + smart account immediately; Self triggered only at the four value-bearing moments below. This section maps that policy onto specific SDK callsites so consumer-app developers know exactly where their users will see the Self prompt.

#### The four trigger moments, by SDK callsite

| # | Trigger | SDK callsites that auto-prompt Self if not verified |
|---|---|---|
| 1 | **Verified-flavor conversation** | `messaging.openConversation({ flavor: 'verified' })`, `messaging.createGroup({ flavor: 'verified' })`, `conversation.upgradeToVerified()`. The SDK checks the verification state of the local user (and the peer, for openConversation) and runs the Self flow inline if needed. |
| 2 | **Contract signing** | `signAndSendTx`, `escrow.acceptContract`, `escrow.checkIn`, `escrow.checkOut`, `escrow.attestCrewMember`, and any custom `signTypedData` call where the consumer-app contract requires a verified signer (declared in scope onboarding). |
| 3 | **Financial features** | `payments.send`, `payments.openOnRamp`, `payments.openOffRamp`, `payments.list`, and any other `payments.*` method. **All financial primitives require Self** because country selective-disclosure is what drives provider routing (Pix BR, GCash PH, Mobile Money NG/KE, etc.) — there is no fallback path for unverified users on the financial surface. |
| 4 | **Sharing a document into a verified context** | `documents.requestShare({ recipient })` where `recipient` is a verified-context surface (e.g. a match-room, an escrow contract, another verified-flavor conversation). The SDK checks the recipient context and prompts Self only if the share target is verified-flagged. Sharing into unverified contexts (or simply storing / viewing your own documents) does NOT trigger Self. |

#### Callsites that NEVER trigger Self

For clarity — and so consumer apps can confidently expose these surfaces to unverified users:

- `signIn` (default policy) — passkey + smart account, no Self.
- `linkedAccount.set / update / get / unlink` — no Self.
- `messaging.openConversation({ flavor: 'social' })` and all social-flavor messaging.
- `messaging.requestHandshake` — Bloom filter graph is keyed on smart-account address (see Cofferdam README §4.2.3), no nullifier required.
- `documents.upload`, `documents.list`, `documents.getThumbnail`, `documents.view`, `documents.openInCofferdam` — Vault is unverified-friendly by design.
- `documents.requestShare` into an unverified-context recipient.
- `getSession`, `signOut`, `refreshIdentity` (with no `requireVerifiedWithin` policy).

#### Inline Self prompt UX

When a callsite trigger fires for an unverified user, the SDK does NOT throw an error. It deep-links the user into the Cofferdam app's Self verification flow, runs the NFC passport scan, waits for the LayerZero V2 callback to bind the nullifier on ZKSync Era, and *then* completes the original SDK call. From the consumer app's perspective the call simply takes longer the first time; from the user's perspective they get a single, contextual *"Verify to continue with [feature]"* prompt explaining why the verification is needed.

```ts
// Consumer-app code is identical whether the user is verified or not:
await cofferdam.payments.openOffRamp({ amount: 100, currency: 'BRL' })

// Internally, the SDK:
//   1. Checks: is the user verified?
//   2. If yes → opens the off-ramp picker (country-routed via Self claims).
//   3. If no  → opens the Cofferdam app, runs Self NFC flow, waits for the
//              LayerZero callback, THEN opens the off-ramp picker.
//
// The consumer app sees a single Promise resolution either way.
```

The consumer app can opt into a more explicit UX by calling `cofferdam.refreshIdentity({ policy: { requireVerifiedWithin: 0 } })` *before* the gated action, so the verification prompt happens at a UX-controlled moment rather than mid-flow. Both patterns are first-class.

#### Why this matters commercially

This is the **conversion mechanism** that makes Cofferdam viable for consumer-app integrators in markets where users are sceptical of identity-binding apps. The integrator gets:

- A passkey-bound, gas-sponsored smart account at signup (zero friction).
- Free social-flavor messaging + free Vault, both Self-free (immediate utility).
- Self verification triggered exactly at the moment the user expects it — when they're applying for a job, signing a contract, or moving money.

Versus the alternative (mandatory Self at signup), which kills 60–80% of installs in the maritime / emerging-market demographics this product is built for.

> **The SDK's job is to make this policy invisible to the consumer-app developer.** You write `payments.openOffRamp(...)`; the SDK handles the verification choreography for you. Same for messaging flavor, escrow signing, and verified-context document sharing.

---

## 3. Consumer-app enforcement policies

The SDK takes a `policy` object on every call. The policy is enforced **client-side by the Cofferdam app**, then re-verified by Cofferdam's backend, then optionally re-verified on-chain by the consumer app's smart contracts. Defense in depth.

```ts
type SignInPolicy = {
  // Account-creation gating (see §2.2)
  enforceSelfBeforeAccount?: boolean // default: false

  // Per-call verification freshness
  requireVerifiedWithin?: number      // seconds since last Self proof
                                      // default: undefined (any prior verification is fine)

  // Selective disclosure
  requireClaims?: Array<
    | 'country'
    | 'olderThan:18' | 'olderThan:21' | 'olderThan:25'
    | 'ofacClear'
    | 'nationality'
  >

  // Country gating
  allowedCountries?: string[]         // ISO-3166 alpha-2
  blockedCountries?: string[]

  // Multi-device freshness
  requirePasskeyFreshness?: number    // seconds since last passkey signature
                                      // useful for high-value transactions
}
```

Examples:

```ts
// OffshoreSync sign-in: maximally permissive, defer all checks to feature-time.
const policy = {}

// OffshoreSync job apply (sensitive action): require recent verification.
const policy = {
  requireVerifiedWithin: 90 * 24 * 60 * 60, // 90 days
  requireClaims: ['country', 'ofacClear'],
}

// A regulated US-only financial app:
const policy = {
  enforceSelfBeforeAccount: true,
  allowedCountries: ['US'],
  requireClaims: ['olderThan:18', 'ofacClear'],
  requirePasskeyFreshness: 5 * 60, // 5 minute biometric re-auth
}
```

---

## 4. API surface

> Names and signatures below are illustrative — final API stabilizes at v0.1. Today's reading: *"this is the shape of the developer experience."*

### 4.1 Initialization

```ts
import { Cofferdam } from '@cofferdam/sdk'

const cofferdam = new Cofferdam({
  scope: 'offshoresync',           // your app identifier, registered with Cofferdam
  scopeDisplayName: 'OffshoreSync',
  scopeIcon: 'https://offshoresync.com/icon.png',
  network: 'mainnet',              // 'mainnet' | 'testnet'
  policy: {
    // default policy — overridable per call
  },
})
```

### 4.2 Identity

```ts
// Sign in
const session = await cofferdam.signIn({ policy?: SignInPolicy })
// → SignInResponse | { error: 'cancelled' | 'no_passkey' | ... }

// Check current session
const session = cofferdam.getSession()
// → SignInResponse | null

// Sign out
cofferdam.signOut()
// → void

// Request a fresh Self verification (e.g. before a sensitive action)
const proof = await cofferdam.refreshIdentity({
  policy: { requireVerifiedWithin: 0 },
})
// → SignInResponse with fresh proofTimestamp
```

#### Account linking metadata

After sign-in, the consumer app supplies the per-user handle that should appear in the user's Cofferdam *Settings → Linked accounts* view. The app's display name + icon come from your registered `scope` (see initialization); only the per-user handle is sent per-call.

```ts
// Register the user's handle in your app with Cofferdam.
// Sent as an encrypted payload (decrypted only on the user's device);
// Cofferdam's backend never sees plaintext.
await cofferdam.linkedAccount.set({
  username: 'john_doe_eng',          // shown as "@john_doe_eng" in Cofferdam
  displayName: 'John Doe',            // optional full display name override
})

// Update later — e.g. user changed their OffshoreSync username.
// Same encrypted-payload semantics.
await cofferdam.linkedAccount.update({
  username: 'new_username',
})

// Read the consumer app's current linked-account state for this user
// (rare; mostly for debugging or UI display in the consumer app).
const linked = cofferdam.linkedAccount.get()
// → { username, displayName, linkedAt, lastUpdatedAt } | null

// Unlink — typically initiated by the user from Cofferdam's Settings,
// not by the consumer app. But available if the consumer app wants to
// offer "Unlink Cofferdam" inside its own settings.
await cofferdam.linkedAccount.unlink()
```

The consumer app should call `linkedAccount.set()` once per user (post-sign-in), then `linkedAccount.update()` whenever the user's handle changes inside the consumer app. Cofferdam treats the handle as the user-facing display label for the link; the underlying `appPseudonym` is the stable cryptographic identifier and is never displayed.

### 4.3 Signing — on-chain transactions

```ts
// Ask the user to sign an arbitrary ZKSync Era transaction.
// Cofferdam handles paymaster sponsorship if configured.
const txHash = await cofferdam.signAndSendTx({
  to:          '0x…',
  data:        '0x…',
  value:       0n,
  description: 'Accept job contract #1234 with Acme Drilling',
  chain:       'zksync-era',     // 'zksync-era' | 'celo'
  sponsorship: 'auto',           // 'auto' | 'self' | 'none'
})

// Convenience helpers for known contract types
const txHash = await cofferdam.escrow.acceptContract({
  contractAddress: '0x…',
  contractId:      1234n,
})

const txHash = await cofferdam.escrow.checkIn({ contractId: 1234n })
const txHash = await cofferdam.escrow.checkOut({ contractId: 1234n })

// Captain co-attests another user's check-in
const txHash = await cofferdam.escrow.attestCrewMember({
  contractId:  1234n,
  crewAddress: '0x…',
  vesselId:    'IMO1234567',
  date:        '2026-05-17',
})
```

### 4.4 Documents (Vault)

The Vault is **generic, per-scope, and parser-configurable** — see §4.1.4 of the Cofferdam README for the full architecture. The SDK surface mirrors the dual-flavor messaging primitive: consumer apps can use their own UI on top of the SDK *or* defer to the Cofferdam app's Vault UI, with the same cryptographic substrate either way.

#### 4.4.1 Per-scope parser configuration (integration-onboarding)

Each consumer app registers, at integration-onboarding time, the document categories it supports and the parsing schema to apply per category. This is a static config; it ships with your SDK initialization.

```ts
// Register at scope-onboarding time (one-shot; can be updated by re-registration).
// Cofferdam stores the schema registry server-side and routes uploads accordingly.
await cofferdam.scope.registerDocumentCategories([
  {
    category: 'maritime-certificate',
    parser:   'gemini-vision',
    schema:   'stcw-certificate-v1',     // pre-registered Cofferdam schema,
                                          // OR an inline custom schema object
    display:  {
      // Optional: tells the Cofferdam app how to render this category in
      // its unified Vault inbox. Falls back to a generic key/value renderer.
      title:    '${certCode} – ${issuer}',
      subtitle: 'Expires ${expiryDate}',
      badge:    'OffshoreSync',
      icon:     'https://offshoresync.com/icon.png',  // app icon, configured at scope
    },
  },
  {
    category: 'job-contract',
    parser:   'gemini-vision',
    schema:   'maritime-job-contract-v1',
    display:  { title: 'Contract #${contractId}', subtitle: '${vessel}' },
  },
  {
    category: 'raw-document',
    parser:   'none',                     // no Gemini Vision; blob + thumbnail only
    display:  { title: '${filename}', subtitle: 'Personal document' },
  },
])
```

A consumer app that doesn't want ANY parsing — e.g. a notary app, a medical-record vault, a legal-correspondence archive — registers all its categories with `parser: 'none'`. Cofferdam stores the encrypted blob + thumbnail and never invokes Gemini Vision. The Cofferdam Vault UI renders a generic document card.

#### 4.4.2 Upload a document

```ts
// Upload a document to the user's Vault, scoped to your consumer app.
// The blob is encrypted client-side; the TEE Worker decrypts in isolated
// memory ONLY if your scope's registered parser requires it.
const doc = await cofferdam.documents.upload({
  blob:     fileBlob,                    // File | Blob | ArrayBuffer
  filename: 'BOSIET_2026.pdf',
  category: 'maritime-certificate',      // must match a registered category
  context: {                             // arbitrary consumer-app metadata
    candidateId:  'cand_1234',
    uploadedFrom: 'profile-settings',
  },
})
// → {
//     docId:        'doc_4f8a3b…',
//     thumbnailUrl: 'https://r2.cofferdam.xyz/thumb/…',  // encrypted; SDK
//                                                         // decrypts on render
//     parsed: {                                           // null if parser='none'
//       certCode:          'BOSIET',
//       issuer:            'OPITO',
//       issuedDate:        '2024-03-15',
//       expiryDate:        '2028-03-15',
//       certificateNumber: 'OPITO-12345',
//       holderNameHash:    '0x…',
//     },
//     uploadedAt:   1700000000,
//   } | { error: 'parse_failed' | 'category_unregistered' | 'quota_exceeded' | ... }
```

#### 4.4.3 List and view the user's documents (consumer-app UI)

```ts
// List the user's documents in your scope. Use this to populate your own
// Certificate Wallet / Vault UI.
const docs = await cofferdam.documents.list({
  category: 'maritime-certificate',     // optional filter
  // optional: sortBy, limit, cursor for pagination
})
// → Array<{ docId, category, parsed, thumbnailUrl, uploadedAt, expiresAt }>

// Decrypt + render a thumbnail on-demand (the SDK handles the key derivation
// + WebCrypto under the hood).
const thumb = await cofferdam.documents.getThumbnail({ docId: doc.docId })
// → Blob (ready to assign to <img src={URL.createObjectURL(thumb)} />)

// Get a one-shot decrypted view of the full document (for in-app viewing).
// The plaintext lives in the consumer-app client's memory ONLY for the
// lifetime of the resulting Blob URL.
const blob = await cofferdam.documents.view({ docId: doc.docId })
// → Blob (PDF / image, depending on original upload)
```

#### 4.4.4 Open in Cofferdam (defer to Cofferdam's UI)

```ts
// Skip building your own viewer and deep-link straight into the Cofferdam
// app's Vault. The user sees the document rendered using the display schema
// you registered in §4.4.1, in Cofferdam's polished native UI, for free.
await cofferdam.documents.openInCofferdam({
  docId: doc.docId,
  // OR: scope:'mine', category:'maritime-certificate' to open the category list
})
// → opens the Cofferdam app via deep-link; returns when user navigates back
//   (or immediately, if the consumer app doesn't await the dismissal).
```

Use this when you want to ship documents-as-a-feature without building a viewer UI. The user gets a polished experience; you get one less surface to maintain. (You can mix and match — use your own UI for the list, deep-link to Cofferdam for the full-document view, or vice versa.)

#### 4.4.5 Share a document to your server (existing flow)

```ts
// Ask the user to share a document from their Vault with your server.
// Returns a SharePayload — encrypted blob URL + wrapped decryption key.
// Same primitive that already existed; works for all categories including
// `parser: 'none'` documents.
const share = await cofferdam.documents.requestShare({
  category:  'maritime-certificate',    // optional filter — only show matching docs
  expiresIn: 7 * 24 * 60 * 60,           // seconds; share auto-expires
  recipient: cofferdam.scope,            // your consumer app
})
// → {
//     docId:          'doc_4f8a3b…',
//     blobUrl:        'https://r2.cofferdam.xyz/blob/…',
//     thumbnailUrl:   'https://r2.cofferdam.xyz/thumb/…',
//     decryptionKey:  '<wrapped to your scopeKey>',
//     parsed:         { ... } | null,      // null if scope registered parser='none'
//     category:       'maritime-certificate',
//     expiresAt:      1700604800,
//   }

// Server-side: unwrap the key and decrypt the blob
import { unwrapKey, decrypt } from '@cofferdam/sdk/server'
const key = await unwrapKey(share.decryptionKey, yourServerScopeSecret)
const blob = await fetch(share.blobUrl).then(r => r.arrayBuffer())
const plaintext = await decrypt(blob, key)
```

#### 4.4.6 Notes for consumer apps

- **Parser config is per scope, not per upload.** You can't change the parser dynamically per-document — register all your categories upfront. This keeps the TEE attestation surface stable + auditable.
- **`parser: 'none'` is a first-class option.** If your app stores sensitive documents you don't want Gemini Vision touching (medical, legal, personal), register the category with no parser. Cofferdam stores the encrypted blob + thumbnail with zero plaintext exposure.
- **Cross-scope visibility is one-way: the user only.** A document uploaded under your scope is visible only to your scope (via the SDK) AND to the user themselves (via the Cofferdam app's unified Vault). It is *never* visible to any other consumer app's scope.
- **The Cofferdam app is your free UI option.** Same pattern as messaging (§4.5): you can ship your own document UI on top of the SDK *or* defer entirely to the Cofferdam app via `openInCofferdam`. Both work; pick per-surface.

### 4.5 Messaging

#### 4.5.1 One-on-one conversations

```ts
// Establish (or fetch) an E2EE conversation between two of your app's users.
//
// The peer is identified by their appPseudonym in YOUR app — the same value
// you got back as `appPseudonym` from THEIR sign-in. The SDK never asks for,
// and you never store, the peer's Cofferdam nullifier or their pseudonym in
// any other app.
//
// If A and B have never handshaken on Cofferdam (verified flavor only),
// this call AUTOMATICALLY triggers an SDK-bridged handshake (Cofferdam
// Mode B). B receives a one-tap accept push; on accept, the conversation
// opens.
const conv = await cofferdam.messaging.openConversation({
  peer: 'cd_pseudo_4f8a…',       // peer's appPseudonym in your scope
  flavor: 'social',              // 'social' | 'verified' | 'auto'
                                 //   - 'social':   no nullifier required;
                                 //                 conversation lives only
                                 //                 in your app's scope
                                 //   - 'verified': both parties must have a
                                 //                 nullifier; on-chain anchored
                                 //   - 'auto':     verified if both have Self,
                                 //                 else social
  context: {                     // arbitrary consumer-app metadata
    type:        'profile-message',
    bridgeProof: 'mutual-friend-on-offshoresync',
    // Optional human-readable string Cofferdam shows to B in the
    // handshake request: "Alice wants to message you. Alice is your
    // friend on OffshoreSync."
  },
  onHandshakeNeeded: 'auto',     // 'auto' | 'prompt' | 'fail'
                                 // (applies to verified flavor only)
})
// → ConversationHandle | { error: 'handshake_declined' | 'cancelled' | ... }

// Send a message via the Cofferdam app (deep-link), or use the embedded
// JS messenger surface if the consumer app wants to render its own UI.
await conv.sendText('Hi, are you available for the rig job in July?')
await conv.sendAttachment(file)

// Subscribe to new messages
conv.on('message', (msg) => {
  // msg is decrypted client-side via the SDK's WebCrypto bindings
  renderInConsumerAppUI(msg)
})

// Promote a social conversation to verified once both parties complete Self
// verification (e.g. after both apply to a vacancy). Existing message history
// is re-encrypted under the new key envelope on the next epoch boundary;
// participants see a system message: "This chat is now anchored to your
// verified identities."
await conv.upgradeToVerified()
// → { status: 'upgraded' | 'pending_peer_verification' | 'declined' }
```

#### 4.5.2 Explicit handshake (without opening a conversation)

```ts
// For consumer apps that want to bridge a handshake without immediately
// starting a chat — e.g. "Add to my Cofferdam crew" button on a profile,
// independent of any DM.
const result = await cofferdam.messaging.requestHandshake({
  peer: 'cd_pseudo_4f8a…',         // peer's appPseudonym in your scope
  context: {
    bridgeProof: 'mutual-friend-on-offshoresync',
    note:        'Add as crew contact',
  },
})
// → { status: 'pending' | 'accepted' | 'declined' | 'already_handshaken' }
```

#### 4.5.3 Groups

```ts
// Create a new group from a list of consumer-app-known users. The SDK
// filters to only those with a linked Cofferdam account; non-linked users
// receive a soft prompt to install Cofferdam first (or are silently
// skipped, depending on policy).
const group = await cofferdam.messaging.createGroup({
  name:    'Vessel Atlantis crew rotation – July 2026',
  peers:   ['cd_pseudo_4f8a…', 'cd_pseudo_2a1c…', 'cd_pseudo_91be…'],
                                 // each peer's appPseudonym in your scope
  flavor:  'social',             // 'social' | 'verified' | 'auto'
  context: {
    type:        'vessel-crew',
    vacancyId:   'vac_98765',
    bridgeProof: 'shared-vacancy-on-offshoresync',
  },
  onUnlinked:    'prompt',       // 'prompt' | 'skip' | 'fail'
})
// → GroupHandle
//   Each linked invitee gets a one-tap accept push;
//   group.on('memberJoined', ...) fires as they accept.

// Open an existing group
const group = await cofferdam.messaging.openGroup({ groupId: 'crew_atlantis_2026' })

// Invite more members later
await group.invite({
  peers: ['cd_pseudo_77ad…'],
  context: { bridgeProof: 'added-by-captain' },
})

// Group epoch key rotates on every member join / leave, preserving
// forward secrecy at epoch boundaries.
```

#### 4.5.4 Notes for consumer apps

- `bridgeProof` is a free-form string the consumer app uses to give Cofferdam (and the receiving user) social context for the handshake request. It's stored client-side, displayed to the recipient, and forms part of the handshake envelope's signed payload — so a malicious consumer app can't lie about *who* requested without the user accepting.
- `onHandshakeNeeded: 'fail'` is appropriate for consumer apps that want to require an explicit "add as friend" step *before* showing a Message button (Cofferdam stays out of the friending UX).
- Air-gapped (Mode C) handshakes are **not exposed via the SDK** — they are inherently a Cofferdam-app-only flow because both devices must be in physical proximity. Consumer apps surface a CTA *"Open Cofferdam to scan crew QR"* if they want to direct users into that flow.

### 4.6 Payments

```ts
// Open Cofferdam's send-money flow with pre-filled fields.
// The consumer app never touches funds.
const result = await cofferdam.payments.send({
  to:          '0x…',            // or toHandle: '@hoff'
  amount:      '1500.00',
  token:       'USDC',
  chain:       'zksync-era',     // user may switch to 'celo' if they prefer
  memo:        'Contract #1234 settlement bonus',
})
// → { txHash, chain } | { error: 'cancelled' | 'insufficient_balance' | ... }

// Open the off-ramp flow with Self-driven provider routing
const result = await cofferdam.payments.offramp({
  amount: '1500.00',
  // Cofferdam picks the provider based on the user's Self-verified country
  // and on the user's preferred off-ramp setting.
})

// Read-only: query the user's payment history for the consumer app's scope
const history = await cofferdam.payments.history({
  filter: { scope: cofferdam.scope }, // only show this app's settlements
})
```

### 4.7 Custom ZK proofs (future)

```ts
// Once Cofferdam adds support for custom ZK proof circuits beyond Self.xyz
// (e.g. STCW certification proofs), the SDK exposes them via:
const proof = await cofferdam.proofs.request({
  circuitId: 'stcw-v6-1',
  publicInputs: { issuedAfter: '2020-01-01', vesselClass: 'oil-rig' },
})
// → { proof, publicSignals, verifierAddress, attesterSig }
```

### 4.8 Development: mock provider and named fixtures

During α-1 (no Cofferdam mobile app, no chain), `network: 'mock'` instantiates an in-process `MockProvider` that returns deterministic-but-realistic `SignInResponse` values. The SDK ships a registry of named fixtures that exercise each `SignInPolicy` gate documented in §3 — pick one with an env var, no code change required.

```ts
import { MockProvider, mockProfiles } from '@cofferdam/sdk/mock'

const profile = process.env.COFFERDAM_MOCK_PROFILE ?? 'verified-br'
const provider = new MockProvider({
  scope: 'offshoresync',
  ...mockProfiles[profile],
})
```

| Profile | `verified` | Country | Age band | OFAC | Proof age | Tests |
|---|---|---|---|---|---|---|
| `verified-br` *(default)* | true | BR | 18+ | clear | fresh | happy path |
| `verified-us` | true | US | 21+ | clear | fresh | `allowedCountries` / `blockedCountries` gates |
| `unverified` | false | — | — | — | — | `enforceSelfBeforeAccount: true` rejection |
| `ofac-flagged` | true | XX | 18+ | **flagged** | fresh | sanctions-screening UI |
| `stale-proof` | true | BR | 18+ | clear | **200 days old** | `requireVerifiedWithin` re-verification flow |

Each profile has a stable `mockUserId`, so a given profile's `appPseudonym` and `accountAddress` are byte-identical across runs — useful for snapshot tests and screenshot pipelines. `getMockProfile(name)` is a runtime-safe lookup that throws on typos with a list of available names.

> **Stability contract:** within a semver-minor release, profile names map to fixed `mockUserId`s and therefore fixed derived identifiers. New profiles may land in minor releases; existing ones will not change identifiers.

---

## 5. Security model

### 5.1 Trust boundary

| Component | Trust level | Notes |
|---|---|---|
| **Consumer app** | Untrusted with secrets, trusted with scoped identity | Receives the user's account address + verification status, but never any key. Can be malicious without compromising the user's master key. |
| **`cofferdam-sdk` (client-side)** | Lightweight broker | Doesn't hold keys. Constructs deep-links, verifies attestations, wraps WebCrypto APIs. Auditable, < 5k LOC core. |
| **Cofferdam mobile app** | Trusted root | Holds the passkey, the master key derivations, the document vault, the messaging keys. This is the security perimeter. |
| **Device Secure Enclave / StrongBox** | Hardware root | The passkey private key never leaves it. |
| **Cofferdam backend (Cloudflare)** | Semi-trusted | Sees encrypted blobs, public profile metadata, Bloom filter pointers, audit logs. Cannot decrypt documents or messages. |
| **Self.xyz TEE** | External trust anchor | Briefly sees passport biometrics during proof generation. Then forgets. |

### 5.2 Per-consumer-app key scoping

Every consumer app gets a **derived sub-key** (`scopeKey`) — deterministically derived from the user's master key + the consumer app's registered scope identifier. This means:

- A document shared with OffshoreSync cannot be decrypted by any other consumer app, even if they intercept the encrypted blob URL.
- A consumer app can verify the user's identity is the same across sessions (same `accountAddress` always) without being able to correlate with other consumer apps' sessions (different `scopeKey` per app).
- If a consumer app is compromised, the blast radius is limited to that app's `scopeKey`. The user's master key, other apps' `scopeKey`s, vault, and messages are unaffected.

### 5.3 Phishing resistance

- "Sign in with Cofferdam" only works via the **native deep-link to the Cofferdam app** — there is no in-browser password flow that can be phished.
- The Cofferdam app shows the requesting consumer app's name + icon + registered domain prominently before the user approves.
- Domain verification: consumer apps must register their callback URL with Cofferdam (Apple-style Associated Domains for production). No drive-by sign-in approvals.

### 5.4 Replay resistance

- Every `SignInResponse` is bound to a fresh challenge generated by Cofferdam's backend (or by the consumer-app server, for stricter integrations).
- The challenge is signed by the user's passkey AND included in the attestation envelope.
- Replaying an old `SignInResponse` against a new challenge fails.

### 5.5 Disclosure surface

The SDK is **MIT-licensed and open source**. Any security researcher can audit the deep-link protocol, the attestation format, the WebCrypto wrappers, and the key derivation paths. We will run a bug bounty post-Phase 5 (see Cofferdam roadmap).

### 5.6 Privacy invariant: per-app pseudonyms

> **The Cofferdam nullifier — the user's master identifier — never reaches the consumer app.** Even a total compromise of the consumer app's database cannot tie its user records to a Cofferdam nullifier, to a Self.xyz passport, or to any other consumer app's user records. This is structural, not policy.

**Construction**:

```
appPseudonym(user, app) = H(scopeSalt[app] || nullifier(user) || domain-separator)
```

The `scopeSalt` is a per-consumer-app constant Cofferdam assigns at integration-onboarding time. The hash is computed inside the Cofferdam app on the user's device — the consumer app's server, Cofferdam's backend, and any network observer all see only the `appPseudonym`, never the salt + nullifier combination that produced it.

**What the consumer app stores as the user's primary key**: the `appPseudonym`. Stable across sessions, devices, and passkey rotations. Different from the user's pseudonym in any other consumer app.

**What the consumer app NEVER stores or sees**:
- The Cofferdam nullifier.
- The pseudonym used by the same user in any other consumer app.
- Any sub-key derivation that would let it impersonate the user with another app.
- The list of other consumer apps the user has linked.

**Implications**:
- **Cross-app correlation requires Cofferdam-side cooperation.** A union of breached databases from N consumer apps cannot identify which records belong to the same person — the pseudonyms are uncorrelated by construction.
- **Cofferdam-the-backend cannot correlate beyond what's strictly needed for routing.** Pseudonym ↔ routing-key mappings are stored encrypted at the user-device level for any operation that doesn't strictly require backend coordination.
- **Selective revelation**: a user can choose to reveal their Cofferdam global handle to a consumer app (e.g. for cross-app payments by handle), but this is opt-in and scope-specific.
- **Linked-account UI is Cofferdam-side only**: the user's *Settings → Linked accounts* view inside the Cofferdam app is the only surface where the cross-app set is visible — and even then, only to the user themselves, never to any consumer app.

**Practical consequences for SDK consumers**:
- Use `appPseudonym` as your primary user key everywhere — never `accountAddress` or any handle.
- Update `linkedAccount.update()` when your user changes their in-app username; do not try to maintain your own mapping of nullifier-or-equivalent on your server.
- When passing peers to messaging / handshake / group APIs, always use the peer's `appPseudonym` in *your* scope — never any chain address or external handle.

This is the basis for Cofferdam's commercial-security pitch: **structural unlinkability across consumer apps, not policy-based promises.** It's also the legal foundation for integrating apps that operate in privacy-sensitive jurisdictions — a breach of a consumer app's database cannot, by construction, leak the link between a user's app-side records and their on-chain or biometric identity.

---

## 6. OffshoreSync reference integration

The first published integration. Lives at [`examples/offshoresync/`](./examples/offshoresync/) (will mirror the production code in the OffshoreSync repos).

```tsx
// react-client/src/components/auth/SignInWithCofferdam.tsx
import { CofferdamProvider, useSignInWithCofferdam } from '@cofferdam/sdk/react'

export function SignInWithCofferdamButton() {
  const { signIn, session } = useSignInWithCofferdam()

  if (session) {
    return <ProfileMenu session={session} />
  }

  return (
    <Button
      onClick={() => signIn({ /* default OffshoreSync policy */ })}
      icon={<CofferdamIcon />}
    >
      Sign in with Cofferdam
    </Button>
  )
}
```

```tsx
// react-client/src/components/jobs/JobApplyButton.tsx
export function JobApplyButton({ vacancy }) {
  const { ensureVerified } = useCofferdam()

  const onApply = async () => {
    const session = await ensureVerified({
      requireVerifiedWithin: 90 * 24 * 60 * 60,
      requireClaims: ['country', 'ofacClear'],
    })
    if (!session) return // user cancelled

    await api.post('/jobs/apply', { vacancyId: vacancy.id })
  }

  return <Button onClick={onApply}>Apply</Button>
}
```

```tsx
// react-client/src/components/certificates/CertificateWallet.tsx
//
// The existing OffshoreSync Certificate Wallet UI, lifted onto the SDK.
// Lists the user's maritime certificates from their Cofferdam Vault,
// scoped to OffshoreSync. UX unchanged from today; cryptographic +
// storage substrate is now Cofferdam.
export function CertificateWallet() {
  const { documents } = useCofferdam()
  const [certs, setCerts] = useState<DocSummary[]>([])

  useEffect(() => {
    documents.list({ category: 'maritime-certificate' }).then(setCerts)
  }, [documents])

  return (
    <CardStack>
      {certs.map(cert => (
        <CertificateCard
          key={cert.docId}
          thumbnail={documents.getThumbnail({ docId: cert.docId })}
          certCode={cert.parsed?.certCode}
          issuer={cert.parsed?.issuer}
          expiryDate={cert.parsed?.expiryDate}
          onTap={() => documents.openInCofferdam({ docId: cert.docId })}
          //         ^ defer the full-document viewer to the Cofferdam app;
          //           we don't need to build our own PDF renderer.
        />
      ))}
      <AddCertificateButton />
    </CardStack>
  )
}
```

```tsx
// react-client/src/components/certificates/AddCertificateButton.tsx
//
// Upload a new certificate to the user's Cofferdam Vault. Encrypted
// client-side; the TEE Worker runs the OffshoreSync-registered
// `stcw-certificate-v1` parser and returns structured metadata. The
// plaintext blob never reaches OffshoreSync's server.
export function AddCertificateButton() {
  const { documents } = useCofferdam()

  const onPick = async (file: File) => {
    const doc = await documents.upload({
      blob:     file,
      filename: file.name,
      category: 'maritime-certificate', // registered at scope-onboarding
      context:  { uploadedFrom: 'certificate-wallet' },
    })
    if ('error' in doc) return showError(doc.error)

    // Optionally surface the parsed structured fields in OffshoreSync's
    // existing certificate-detail UI. Same fields as before; new pipeline.
    showCertificateAdded(doc.parsed)
  }

  return <FilePicker accept="application/pdf,image/*" onPick={onPick} />
}
```

```tsx
// react-client/src/components/certificates/ShareCertificateWithRecruiter.tsx
//
// During a match-room conversation, a worker shares a specific certificate
// with a recruiter. OffshoreSync's server only stores the wrapped
// decryption key + structured metadata; the plaintext blob lives in
// Cofferdam's R2.
export function ShareCertificateWithRecruiter({ matchId }) {
  const { documents } = useCofferdam()

  const onShare = async () => {
    const share = await documents.requestShare({
      category:  'maritime-certificate', // user picks from list
      recipient: 'offshoresync',
      expiresIn: 365 * 24 * 60 * 60,     // 1 year share window
    })
    if (!share) return

    // Attach to the match-room as encrypted-blob + wrapped-key envelope.
    await api.post(`/match-rooms/${matchId}/attach-certificate`, share)
  }

  return <Button onClick={onShare}>Share certificate</Button>
}
```

```tsx
// react-client/src/components/jobs/ContractSignFlow.tsx
export function ContractSignFlow({ contract }) {
  const { escrow } = useCofferdam()

  const onSign = async () => {
    const txHash = await escrow.acceptContract({
      contractAddress: contract.escrowAddress,
      contractId: contract.id,
    })
    if (!txHash) return // user cancelled

    await api.post('/contracts/signed', { contractId: contract.id, txHash })
  }

  return <Button onClick={onSign}>Sign contract</Button>
}
```

```tsx
// react-client/src/components/profile/MessageButton.tsx
//
// Shown on a friend's profile in OffshoreSync. Tapping opens a Cofferdam
// E2EE DM, transparently bridging the handshake on first message.
export function MessageButton({ friend }) {
  const { messaging, session } = useCofferdam()

  // OffshoreSync stores friend.appPseudonym (our scope's pseudonym for that
  // user) — NEVER a nullifier or any cross-scope identifier. See §5.6.
  // Hide the button if either party hasn't linked their Cofferdam account.
  if (!session || !friend.appPseudonym) {
    return <CofferdamInstallNudge friend={friend} />
  }

  const onMessage = async () => {
    const conv = await messaging.openConversation({
      peer:   friend.appPseudonym,    // peer's appPseudonym in OffshoreSync scope
      flavor: 'social',                // OffshoreSync profile DM, no Self required
      context: {
        type:        'profile-message',
        bridgeProof: `friends-on-offshoresync:${session.appPseudonym}:${friend.appPseudonym}`,
      },
      onHandshakeNeeded: 'auto',       // first message auto-bridges the handshake
                                       // (verified flavor only — no-op here)
    })
    if ('error' in conv) return // user cancelled / handshake declined

    // Either render inline via @cofferdam/sdk-react's <ConversationView />,
    // or deep-link to Cofferdam to continue. The thread is the SAME thread
    // either way — see §4.2 of the Cofferdam README ("same conversation,
    // multiple UIs").
  }

  return <Button onClick={onMessage}>Message</Button>
}
```

```tsx
// react-client/src/components/jobs/CreateCrewGroupButton.tsx
//
// Shown to recruiters on a vacancy applicant pool view. Tapping creates
// a Cofferdam group with all selected candidates who have linked Cofferdam.
export function CreateCrewGroupButton({ vacancy, selectedCandidates }) {
  const { messaging } = useCofferdam()

  const onCreate = async () => {
    const group = await messaging.createGroup({
      name:   `${vacancy.vesselName} – ${vacancy.role} crew`,
      peers:  selectedCandidates                       // OffshoreSync-scope
        .map(c => c.appPseudonym)                      // pseudonyms only
        .filter(Boolean),
      flavor: 'social',                                // not escrow-bound; vacancy
                                                       // applicants haven't all
                                                       // accepted yet
      context: {
        type:        'vacancy-crew',
        vacancyId:   vacancy.id,
        bridgeProof: `shared-vacancy-on-offshoresync:${vacancy.id}`,
      },
      onUnlinked: 'prompt', // unlinked candidates get an install nudge
    })
    if ('error' in group) return

    // Cofferdam delivers the invite push to each selected candidate.
    // Recruiter sees the group open in Cofferdam with members joining
    // as they accept.
  }

  const linkedCount = selectedCandidates.filter(c => c.appPseudonym).length

  return (
    <Button onClick={onCreate}>
      Create crew group ({linkedCount}/{selectedCandidates.length} on Cofferdam)
    </Button>
  )
}
```

```tsx
// react-client/src/hooks/useSyncUsernameWithCofferdam.ts
//
// When the user changes their OffshoreSync username, propagate the new handle
// to Cofferdam so it shows up in their Linked accounts UI (§4.4 of the
// Cofferdam README).
import { useCallback } from 'react'
import { useCofferdam } from '@cofferdam/sdk-react'

export function useSyncUsernameWithCofferdam() {
  const { linkedAccount, session } = useCofferdam()

  return useCallback(async (newUsername: string) => {
    if (!session) return // user hasn't linked Cofferdam; nothing to sync
    await linkedAccount.update({ username: newUsername })
  }, [linkedAccount, session])
}
```

The reference integration is the canonical answer to *"how do I use this SDK?"* — and it's the production code, not a toy example.

---

## 7. Pricing, paymaster, and metering

> The SDK is **free to install, free to ship in your binary, and free to use up to the Tier 0 cap**. Past that cap, your app moves to Tier 2 (per-MAU + metered events) or Tier 3 (enterprise). This section is the consumer-app-facing slice of [`Cofferdam/README.md` §10 — Economics, paymaster, and revenue model](../Cofferdam/README.md#10-economics-paymaster-and-revenue-model), with the SDK-specific callsites that drive billing.

### 7.1 What you pay for, what you don't

| You pay for | You do not pay for |
|---|---|
| Active Cofferdam-signed-in users in your app (MAU base fee, Tier 2+) | The SDK itself, npm install, distribution |
| Verified-flavor conversations opened by your app's users | Social-flavor conversations |
| Documents your app parses through the Vault's Gemini pipeline | Documents your app uploads with `parser: 'none'` (blob-only) |
| Escrows your app creates (take rate on notional) | Escrow *viewing* / status reads |
| LayerZero attestation mirrors triggered by your app | Self verification gas (paymaster-borne in Plan A; user-borne in Plan B — never integrator-borne) |
| Per-call overages above the Tier 2 included quotas | API calls that are read-only / metadata-only |

### 7.2 Tiers (consumer-app pricing)

| Tier | Price | MAU cap | Verified DMs | Vault parsing | Escrow / financial | SLA |
|---|---|---|---|---|---|---|
| **Tier 0 — Community** | $0 | 1,000 | ❌ (social only) | ❌ (blob storage only) | ❌ | Best effort |
| **Tier 1 — Reference** | $0 | unlimited | ✅ | ✅ | ✅ | Best effort |
| **Tier 2 — Builder** | $0.05 / MAU / mo + metered | unlimited | $0.02 / conv | $0.10 / doc | 0.5% take | 99.5% |
| **Tier 3 — Enterprise** | from $2,000 / mo + rev share | unlimited | bundled | bundled | 0.2% take | 99.9% |

> *Tier 1 is reserved for OffshoreSync as the reference integration. Every other Cofferdam-using app starts at Tier 0 and moves to Tier 2 when they exceed 1,000 MAUs or call a Tier-gated feature.*

**MAU definition:** A unique `appPseudonym` that completes at least one authenticated SDK call in a rolling 28-day window. Idle installs don't count.

### 7.3 What triggers a billed event (per SDK callsite)

This is the canonical mapping from SDK calls to billable units. The SDK reports these to Cofferdam's metering pipeline automatically — you do not implement any metering code, you just see the line items on your invoice.

| SDK call | Billable | Unit | Notes |
|---|---|---|---|
| `cofferdam.signIn()` first call in 28-day window | ✅ | MAU base fee | Counted once per user per month, not per call. |
| `cofferdam.signIn()` subsequent calls same window | ❌ | — | Free. |
| `messages.open({ flavor: 'social' })` | ❌ | — | Always free. |
| `messages.open({ flavor: 'verified' })` first time per conversation | ✅ | $0.02 / conv | Triggers Self if user not yet verified (paymaster-borne, not billed to you). |
| `messages.send(...)` | ❌ | — | Free; message volume not metered. |
| `groups.create({ flavor: 'verified' })` | ✅ | $0.02 / group, once at creation | Plus $0.02 per member who hasn't been in a verified conv before. |
| `documents.upload({ category, parser: 'none' })` | ❌ | — | Blob storage only; counts toward your storage quota (see §7.5). |
| `documents.upload({ category })` with parser config | ✅ | $0.10 / doc | Gemini Vision parse. |
| `documents.requestShare(...)` | ❌ | — | Free; ciphertext re-wrap only. |
| `documents.openInCofferdam(docId)` | ❌ | — | Free; just a deep link. |
| `signing.signTransaction(...)` against allowlisted contract | ❌ | — | Gas is paymaster-borne; you are not billed. |
| `signing.signTransaction(...)` against non-allowlisted contract | ❌ | — | User-pays gas; SDK call is free. Tier 3 can register custom contracts. |
| `escrow.create({ notional, ... })` | ✅ | 0.5% × notional, capped $20 | Charged on creation; refunded on cancel-before-fund. |
| `escrow.release(...)` | ❌ | — | Take rate already collected at create. |
| `payments.send(...)` (P2P, Cofferdam-to-Cofferdam) | ❌ | — | Subsidized. Gas only. |
| `payments.offRamp(...)` | ❌ | — | You're not billed; **Cofferdam takes 0.3–0.5% directly from the FX spread**, transparent to the user. Tier 3 can negotiate revenue share. |
| `attestation.mirrorToZksync(...)` (LayerZero) | ✅ | $0.30 / mirror | Cross-chain commit pass-through. |
| `identity.linkedAccount.update(...)` | ❌ | — | Free. |
| All `*.list()`, `*.status()`, `*.get(...)` read APIs | ❌ | — | Free. |

### 7.4 The paymaster — how gas sponsorship actually works for your users

Your app never holds gas. Your users never see gas as a line item. The economics that make this true:

```
                ┌──────────────────────────────────────────┐
                │  Cofferdam paymaster pool (per chain)    │
                │                                          │
                │  Funded by: grants + Tier 2/3 revenue    │
                │             + OffshoreSync LLC backstop  │
                └────────────┬─────────────────────────────┘
                             │ sponsors gas for...
                             ▼
       ┌────────────────────────────────────────────────────┐
       │  Allowlisted Cofferdam v1 contracts:               │
       │  • Account deploy                                  │
       │  • Self verifier                                   │
       │  • Escrow factory + escrow instances               │
       │  • Merkle anchor (verified-flavor messaging)       │
       │  • Bloom filter snapshot                           │
       │  • LayerZero attestation mirror                    │
       │  • [Tier 3: your registered contracts]             │
       └────────────────────────────────────────────────────┘
```

What it means for the integrating app:

- **Tier 0 + Tier 2:** Your users' txs against the Cofferdam allowlisted contracts are gas-free. Any tx against contracts you operate yourself (e.g., your own loyalty token) is user-pays unless you fund a Tier 3 paymaster pool.
- **Tier 3:** Cofferdam provisions a **segregated paymaster sub-pool** for your app-id. You fund it (USDC top-up via the partner dashboard). Cofferdam's paymaster contract enforces:
  - Your allowlisted contracts (which you register).
  - A per-user daily cap you set.
  - A per-app monthly budget envelope — at 80% spent, the SDK surfaces a banner to your developer dashboard; at 100%, sponsored txs degrade gracefully to user-pays. No silent failures.
- **Anti-drain:** Every sponsored tx carries a fresh attestation from Cofferdam's backend signer proving the request is from a real authenticated session. The paymaster contract rejects bare calldata, so a bot scraping the allowlist can't burn your pool.

### 7.5 Storage and bandwidth quotas (Vault)

R2 storage is the one place you have a per-user soft cap, because it's the only cost that grows unboundedly with usage:

| Tier | Storage soft cap per user | Overage |
|---|---|---|
| Tier 0 | 50 MB | Blocked at cap; user prompted to clean up. |
| Tier 2 | 500 MB | $0.02 / GB-month over cap. |
| Tier 3 | 2 GB default, negotiable | Tiered overage. |

Files are deduplicated server-side (CID-keyed), so a shared document only counts once per uploader. No bandwidth metering — R2 has zero egress fees, so reads / re-downloads are free.

### 7.6 Billing surface and observability

- **Dashboard at `partners.cofferdam.xyz`.** App-id management, paymaster top-up (Tier 3), live usage charts (MAUs, verified DMs, doc parses, escrow take-rate revenue).
- **Stripe-invoiced monthly.** Tier 2 self-serve via Stripe Subscriptions + Meter Events; Tier 3 NET-30 wire / ACH supported.
- **Free observability:** `GET /v1/usage/me` from your backend returns the same data the dashboard shows — month-to-date counters per billable unit, current paymaster pool state, projected month-end invoice.
- **Hard caps optional.** You can set a hard monthly spend cap; when hit, premium features (verified DMs, parsing, escrow) reject with a typed error your app handles gracefully — social messaging, sign-in, and blob Vault keep working.
- **Public audit log at `audit.cofferdam.xyz`** — every paymaster pool top-up is on-chain and indexed, so you can independently verify your Tier 3 pool's funded balance against your dashboard.

> The platform behind these surfaces (Next.js dashboard, Cloudflare Workers API, Stripe Meter Events pipeline, Safe-multisig treasury, Tier 3 dedicated-paymaster factory) is documented in [`Cofferdam/README.md` §11 — Partners platform](../Cofferdam/README.md#11-partners-platform-dashboard-billing-and-paymaster-operations). As an integrator you don't need to read it — but if you want to know what happens when you click *Top up*, that's where the wiring lives.

### 7.7 What this means for your sign-in conversion

The pricing structure above is designed so that **adding Cofferdam to your app cannot make sign-in worse**. Concretely:

- A new user can sign in, see their profile, message socially, upload documents (blob mode), and use your app's free tier — **all without ever being prompted for Self.xyz, and entirely free for you up to 1,000 MAUs**.
- Self verification is value-gated (§2.4), so the verification prompt only appears when the user is already engaged enough to want the gated feature.
- Once you exceed Tier 0, your unit economics are **predictable per MAU** and your high-margin lines (verified DMs, escrows, financial routing) only fire when the user has chosen to use them — so cost scales with value delivered, not with raw user count.

This is the contract: **you pay only when Cofferdam delivers irreplaceable B2C value through your app**. Everything else is on us.

> See [`Cofferdam/README.md` §10](../Cofferdam/README.md#10-economics-paymaster-and-revenue-model) for the full revenue model, paymaster pool architecture, and the bounty-funded vs unfunded scenarios that govern the Tier 0 cap.

---

## 8. Installation and platforms

> **α-1 status (May 2026):** the SDK is **not yet published to npm**. While we're in alpha, install directly from the GitHub repo via single-package **release branches** auto-maintained by `.github/workflows/release-branches.yml`. Each release branch is a single-commit snapshot, force-pushed by CI on every push to its source branch, where the package's contents (built `dist/` + `src/` + `package.json` + `LICENSE`) sit at the repository root — so yarn 1's native `github:owner/repo#branch` syntax works directly, no third-party tarball service required. Both packages must be listed explicitly because `@cofferdam/sdk-react` declares `@cofferdam/sdk` as a `peerDependency`.

### α-1 (GitHub release branches)

```jsonc
// consumer-app/package.json
{
  "dependencies": {
    "@cofferdam/sdk":       "github:OffshoreSync/cofferdam-sdk#release-core-tests",
    "@cofferdam/sdk-react": "github:OffshoreSync/cofferdam-sdk#release-react-tests"
  }
}
```

Then `yarn install` / `npm install` as usual. For a runnable starting template see [`examples/capacitor-minimal/`](./examples/capacitor-minimal/) — a Vite + React + Capacitor 7 app that mounts `<CofferdamProvider>` + the drop-in `<SignInWithCofferdamButton>` in <80 lines of TSX.

**Branch / ref strategy:**

| Source branch | Release branches | When to pin here |
|---|---|---|
| `tests` | `release-core-tests`, `release-react-tests` | Fast-moving α-1 development. OffshoreSync preview builds gated behind `VITE_COFFERDAM_PREVIEW=1`. |
| `main` | `release-core-main`, `release-react-main` | Stable. Promoted from `tests` at phase boundaries (α-1 → α-2, etc.). Reserve for any consumer that ships to production. |
| any release-branch SHA | n/a | Pin to a specific snapshot for fully reproducible installs: `github:OffshoreSync/cofferdam-sdk#<release-branch-sha>`. |

Release branches are **force-pushed** by CI on every commit to their source branch, so during alpha consumers should run `yarn install --force` (or delete the relevant `node_modules` entry + lockfile entry) to pick up SDK changes. Once we publish to npm, this caveat disappears.

### β onwards (npm registry)

Once we publish to npm under the `@cofferdam` org, the install reduces to:

```bash
# Core (framework-agnostic TypeScript)
npm install @cofferdam/sdk

# React hooks + components
npm install @cofferdam/sdk @cofferdam/sdk-react

# React Native bindings
npm install @cofferdam/sdk @cofferdam/sdk-react-native
# (plus the native modules — see RN setup guide)

# Web "Sign in with Cofferdam" button + WebAuthn flow
npm install @cofferdam/sdk @cofferdam/sdk-web
```

Platform support matrix:

| Platform | Status (initial release) | Notes |
|---|---|---|
| **iOS native (Swift)** | ✅ via `@cofferdam/sdk-react-native` | Cofferdam mobile app is RN, but native consumer apps can integrate via the SDK's URL scheme. Standalone Swift package planned. |
| **Android native (Kotlin)** | ✅ via `@cofferdam/sdk-react-native` | Same as iOS — standalone Kotlin package planned. |
| **React Native (Expo / bare)** | ✅ | First-class. |
| **Capacitor (the main OffshoreSync app)** | ✅ via `@cofferdam/sdk` + Capacitor URL scheme | Deep-link to Cofferdam mobile app. |
| **Web (React)** | ✅ via `@cofferdam/sdk-web` + QR handoff | Desktop web → mobile Cofferdam via QR + return-deep-link. |
| **Node.js (server-side)** | ✅ via `@cofferdam/sdk/server` | Attestation verification + decryption-key unwrapping. |

---

## 9. Repo layout

```
github.com/OffshoreSync/cofferdam-sdk/
├── packages/
│   ├── core/                       ← framework-agnostic TS, no UI
│   │   ├── src/
│   │   │   ├── identity/
│   │   │   ├── signing/
│   │   │   ├── documents/
│   │   │   ├── messaging/
│   │   │   ├── payments/
│   │   │   ├── proofs/
│   │   │   ├── attestation/        ← envelope verification
│   │   │   ├── deeplink/           ← URI construction + parsing
│   │   │   └── policy/             ← policy types + validation
│   │   └── package.json            ← @cofferdam/sdk
│   ├── react/
│   │   ├── src/
│   │   │   ├── CofferdamProvider.tsx
│   │   │   ├── useSignInWithCofferdam.ts
│   │   │   ├── useCofferdam.ts
│   │   │   └── components/
│   │   │       ├── SignInWithCofferdamButton.tsx
│   │   │       └── VerifiedBadge.tsx
│   │   └── package.json            ← @cofferdam/sdk-react
│   ├── react-native/
│   │   ├── ios/                    ← URL scheme registration helper
│   │   ├── android/                ← URL scheme registration helper
│   │   └── package.json            ← @cofferdam/sdk-react-native
│   ├── web/
│   │   ├── src/
│   │   │   ├── webauthn-fallback.ts
│   │   │   └── qr-handoff.tsx
│   │   └── package.json            ← @cofferdam/sdk-web
│   └── server/
│       ├── src/
│       │   ├── verify-attestation.ts
│       │   ├── unwrap-key.ts
│       │   └── decrypt.ts
│       └── package.json            ← @cofferdam/sdk/server
├── examples/
│   ├── offshoresync/               ← reference integration (mirrors prod)
│   ├── nextjs-minimal/
│   ├── expo-minimal/
│   └── capacitor-minimal/
├── docs/
│   ├── getting-started.md
│   ├── policy-reference.md
│   ├── attestation-format.md
│   └── threat-model.md
├── LICENSE
└── README.md (this file)
```

---

## 10. Versioning + release policy

- **Semantic versioning.** v0.x is pre-stable; the API may change between minor versions. v1.0 ships after the OffshoreSync production launch + at least one external integration.
- **Released to npm** under the `@cofferdam/` org. Free to install, free to use, no auth gate.
- **Consumer app registration** is required at the *Cofferdam backend* level (you register your `scope` identifier + callback URLs + display name + icon), not at the SDK level. A self-service portal opens at the Cofferdam beta launch.
- **Breaking changes are documented in `CHANGELOG.md`** with concrete migration recipes.
- **Cofferdam app + SDK version coupling**: the SDK negotiates a protocol version with the Cofferdam app on every call. Older Cofferdam apps gracefully reject calls that require a newer protocol version, and the SDK surfaces an *"Update Cofferdam to continue"* error.

---

## 11. License

MIT — see [LICENSE](LICENSE).

Copyright © 2026 OffshoreSync LLC.

The Cofferdam name and logo are trademarks of OffshoreSync LLC. The SDK code is MIT-licensed; the trademark use is governed by a separate permissive trademark policy.

---

_Last updated: 2026-05-17 — Added §7 Pricing, paymaster, and metering (consumer-app pricing tiers, SDK-callsite billing map, paymaster pool semantics, storage quotas, conversion-preservation contract). API surface is illustrative; final signatures stabilize at v0.1 alongside Cofferdam mobile app's Phase 2 ship._
