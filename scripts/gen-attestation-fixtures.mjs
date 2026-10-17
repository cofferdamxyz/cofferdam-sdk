// Generator: emits real @cofferdam/sdk-signed session-attestation tokens (both
// `p256` and `webauthn` schemes) as JSON so cofferdam-api can pin them as
// cross-repo fixtures (test/fixtures/sdk-attestations.json) and prove its
// viem/@noble verifier is byte-compatible with the SDK's ethers signer.
//
// Usage (from cofferdam-sdk root):
//   yarn build && node packages/core/scripts/gen-attestation-fixtures.mjs
import { writeFileSync } from 'node:fs'
import {
  DeterministicPasskeySigner,
  WebAuthnPasskeySigner,
  softwareWebAuthnAuthenticator,
  softwareWebAuthnPublicKey,
  createSessionAttestation,
  encodeSessionAttestation,
} from '../dist/index.js'

const fields = {
  scope: 'offshoresync',
  appPseudonym: 'cd_pseudo_0123456789abcdef01234567',
  accountAddress: '0x' + 'ab'.repeat(20),
  chainId: 300,
  verified: true,
  issuedAt: 1_750_000_000_000,
}

const P256_PRIV = 'fixture-deterministic-user'
const WEBAUTHN_PRIV = new Uint8Array(32).fill(7)

async function build(signer) {
  const att = await createSessionAttestation({ signer, fields })
  return { token: encodeSessionAttestation(att), att }
}

const p256 = await build(new DeterministicPasskeySigner(P256_PRIV))
const webauthn = await build(
  new WebAuthnPasskeySigner(
    softwareWebAuthnPublicKey(WEBAUTHN_PRIV),
    softwareWebAuthnAuthenticator(WEBAUTHN_PRIV),
  ),
)

const out = {
  _comment:
    'Real @cofferdam/sdk-signed session attestations (signed with ethers). Verified by cofferdam-api (viem + @noble) to prove the two implementations are byte-compatible. Regenerate with `yarn build && node packages/core/scripts/gen-attestation-fixtures.mjs` from the cofferdam-sdk root (writes to ../../../cofferdam-api).',
  fields,
  p256: { alg: p256.att.alg, publicKey: p256.att.publicKey, token: p256.token },
  webauthn: { alg: webauthn.att.alg, publicKey: webauthn.att.publicKey, token: webauthn.token },
}

const json = JSON.stringify(out, null, 2) + '\n'

// Write directly into cofferdam-api so the token can never be corrupted by a
// manual copy/paste. The two repos are siblings in the workspace.
const target = new URL(
  '../../../../cofferdam-api/test/fixtures/sdk-attestations.json',
  import.meta.url,
)
writeFileSync(target, json)
console.log(`Wrote ${target.pathname}`)
console.log('p256 token len:', p256.token.length, 'webauthn token len:', webauthn.token.length)
