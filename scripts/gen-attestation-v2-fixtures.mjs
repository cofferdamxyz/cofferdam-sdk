// Generator: real @cofferdam/sdk-signed `csa1:` v2 tokens and DPoP-shaped
// proofs (workspace decision 0055) for cofferdam-api's cross-repo tests
// (test/fixtures/sdk-attestations-v2.json). The plane verifies them with its
// own viem/@noble code, proving the two implementations agree byte for byte.
//
// The device key is a fixed test scalar, written into the fixture so the
// plane's tests can also sign proofs of their own (replay, tamper). Never a
// real key.
//
// Usage (from cofferdam-sdk root):
//   yarn build && node packages/core/scripts/gen-attestation-v2-fixtures.mjs
import { writeFileSync } from 'node:fs'
import { hexlify } from 'ethers'
import {
  DeterministicPasskeySigner,
  WebAuthnPasskeySigner,
  softwareWebAuthnAuthenticator,
  softwareWebAuthnPublicKey,
  SoftwareDeviceKeySigner,
  signSessionAttestationV2,
  createPopProof,
  jwkThumbprint,
  CSA_AUDIENCE_PLANE,
} from '../dist/index.js'

const ACCOUNT = '0x' + 'ab'.repeat(20)
const ISSUED_AT = 1_750_000_000_000
// Hono's app.request() resolves relative paths against http://localhost.
const ORIGIN = 'http://localhost'

const base = {
  scope: 'cofferdam-app',
  appPseudonym: 'cd_pseudo_0123456789abcdef01234567',
  accountAddress: ACCOUNT,
  chainId: 84532,
  verified: true,
  issuedAt: ISSUED_AT,
  aud: CSA_AUDIENCE_PLANE,
}

const DEVICE_PRIV = new Uint8Array(32).fill(9)
const deviceKey = new SoftwareDeviceKeySigner(DEVICE_PRIV)
const jkt = jwkThumbprint(await deviceKey.publicKey())

const WEBAUTHN_PRIV = new Uint8Array(32).fill(7)
const signers = {
  p256: new DeterministicPasskeySigner('fixture-deterministic-user'),
  webauthn: new WebAuthnPasskeySigner(softwareWebAuthnPublicKey(WEBAUTHN_PRIV), softwareWebAuthnAuthenticator(WEBAUTHN_PRIV)),
}

const fast = { ...base, tier: 'fast', expiresAt: ISSUED_AT + 24 * 60 * 60 * 1000, jkt }
const slow = { ...base, tier: 'slow', expiresAt: ISSUED_AT + 10 * 60 * 1000, jkt }

const out = {
  _comment:
    'Real @cofferdam/sdk csa1 v2 tokens and proofs (workspace decision 0055). The device key is a fixed TEST scalar. Regenerate with `yarn build && node packages/core/scripts/gen-attestation-v2-fixtures.mjs` from the cofferdam-sdk root.',
  account: ACCOUNT,
  origin: ORIGIN,
  issuedAt: ISSUED_AT,
  devicePrivateKey: hexlify(DEVICE_PRIV),
  devicePublicKey: await deviceKey.publicKey(),
  jkt,
  tokens: {},
}

for (const [scheme, signer] of Object.entries(signers)) {
  const publicKey = await signer.publicKey()
  const fastToken = await signSessionAttestationV2({ signer, publicKey, fields: fast })
  const slowToken = await signSessionAttestationV2({ signer, publicKey, fields: slow })
  const now = ISSUED_AT + 1_000
  out.tokens[scheme] = {
    publicKey,
    fast: fastToken,
    slow: slowToken,
    proofs: {
      chat: await createPopProof({ deviceKey, htm: 'POST', htu: `${ORIGIN}/v1/chat`, token: fastToken, now, jti: `chat-${scheme}-0000000000` }),
      usage: await createPopProof({ deviceKey, htm: 'GET', htu: `${ORIGIN}/v1/chat/usage`, token: fastToken, now, jti: `usage-${scheme}-000000000` }),
      pickup: await createPopProof({ deviceKey, htm: 'GET', htu: `${ORIGIN}/v1/self/bind-bundle/${ACCOUNT}`, token: slowToken, now, jti: `pickup-${scheme}-00000000` }),
    },
  }
}

const target = new URL('../../../../cofferdam-api/test/fixtures/sdk-attestations-v2.json', import.meta.url)
writeFileSync(target, JSON.stringify(out, null, 2) + '\n')
console.log(`Wrote ${target.pathname}`)
