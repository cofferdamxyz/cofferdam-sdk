// `csa1:` v2 (workspace decision 0055): the device-bound envelope and the
// per-request proof. Pure: no chain, no network. The fixed vector at the end is
// asserted byte for byte in cofferdam-api's test/sessionAttestation.test.ts.

import { describe, it, expect } from 'vitest'
import { hexlify } from 'ethers'
import {
  DeterministicPasskeySigner,
  WebAuthnPasskeySigner,
  softwareWebAuthnAuthenticator,
  softwareWebAuthnPublicKey,
  SoftwareDeviceKeySigner,
  createSessionAttestationV2,
  encodeSessionAttestationV2,
  decodeSessionAttestationV2,
  decodeAndVerifySessionAttestation,
  decodeAndVerifySessionAttestationV2,
  sessionAttestationV2Digest,
  sessionAttestationVersion,
  signSessionAttestationV2,
  jwkThumbprint,
  createPopProof,
  verifyPopProof,
  popHtu,
  CSA_AUDIENCE_PLANE,
  SESSION_TIER_MAX_LIFETIME_MS,
  SessionAttestationDecodeError,
  SessionAttestationExpiredError,
  SessionAttestationVerificationError,
  PopProofError,
  type SessionAttestationV2Fields,
} from '../src/index.js'

const ACCOUNT = '0x' + 'ab'.repeat(20)
const NOW = 1_800_000_000_000
const URL_CHAT = 'https://cofferdam.xyz/v1/chat'

async function fields(deviceKey: SoftwareDeviceKeySigner, over: Partial<SessionAttestationV2Fields> = {}) {
  return {
    scope: 'cofferdam-app',
    appPseudonym: 'pseudo-1',
    accountAddress: ACCOUNT,
    chainId: 84532,
    verified: true,
    issuedAt: NOW,
    expiresAt: NOW + 60 * 60 * 1000,
    aud: CSA_AUDIENCE_PLANE,
    tier: 'fast' as const,
    jkt: jwkThumbprint(await deviceKey.publicKey()),
    ...over,
  }
}

describe('csa1 v2 envelope', () => {
  it('round-trips and verifies for the raw P-256 and WebAuthn passkeys', async () => {
    const deviceKey = SoftwareDeviceKeySigner.generate()
    const raw = new DeterministicPasskeySigner('user-1')
    const priv = new Uint8Array(32).fill(7)
    const webauthn = new WebAuthnPasskeySigner(softwareWebAuthnPublicKey(priv), softwareWebAuthnAuthenticator(priv))
    for (const signer of [raw, webauthn]) {
      const token = await signSessionAttestationV2({ signer, fields: await fields(deviceKey) })
      expect(sessionAttestationVersion(token)).toBe(2)
      const att = decodeAndVerifySessionAttestationV2(token, { now: NOW + 1000, expect: { accountAddress: ACCOUNT } })
      expect(att.tier).toBe('fast')
      expect(att.cnf.jkt).toBe(jwkThumbprint(await deviceKey.publicKey()))
    }
  })

  it('is refused by the v1 verifier, so an old gate never accepts it unbound', async () => {
    const deviceKey = SoftwareDeviceKeySigner.generate()
    const token = await signSessionAttestationV2({
      signer: new DeterministicPasskeySigner('user-1'),
      fields: await fields(deviceKey),
    })
    expect(() => decodeAndVerifySessionAttestation(token)).toThrow(SessionAttestationDecodeError)
  })

  it('refuses expired, future, over-long, wrong-audience and tampered envelopes', async () => {
    const deviceKey = SoftwareDeviceKeySigner.generate()
    const signer = new DeterministicPasskeySigner('user-1')
    const token = await signSessionAttestationV2({ signer, fields: await fields(deviceKey) })

    expect(() => decodeAndVerifySessionAttestationV2(token, { now: NOW + 60 * 60 * 1000 })).toThrow(
      SessionAttestationExpiredError,
    )
    expect(() => decodeAndVerifySessionAttestationV2(token, { now: NOW - 120_000 })).toThrow(
      SessionAttestationExpiredError,
    )
    expect(() => decodeAndVerifySessionAttestationV2(token, { now: NOW, audience: 'partner-x' })).toThrow(
      SessionAttestationVerificationError,
    )

    await expect(
      createSessionAttestationV2({
        signer,
        fields: await fields(deviceKey, { tier: 'slow', expiresAt: NOW + SESSION_TIER_MAX_LIFETIME_MS.slow + 1 }),
      }),
    ).rejects.toThrow(SessionAttestationVerificationError)

    const att = decodeSessionAttestationV2(token)
    const swapped = encodeSessionAttestationV2({ ...att, tier: 'slow' })
    expect(() => decodeAndVerifySessionAttestationV2(swapped, { now: NOW })).toThrow(
      SessionAttestationVerificationError,
    )
    const otherKey = jwkThumbprint(await SoftwareDeviceKeySigner.generate().publicKey())
    const rebound = encodeSessionAttestationV2({ ...att, cnf: { jkt: otherKey } })
    expect(() => decodeAndVerifySessionAttestationV2(rebound, { now: NOW })).toThrow(
      SessionAttestationVerificationError,
    )
  })
})

describe('proof of possession', () => {
  it('verifies for the request it was made for and names the device key', async () => {
    const deviceKey = SoftwareDeviceKeySigner.generate()
    const token = 'csa1:example'
    const proof = await createPopProof({ deviceKey, htm: 'post', htu: `${URL_CHAT}?x=1#f`, token, now: NOW })
    const out = verifyPopProof(proof, { token, htm: 'POST', htu: URL_CHAT, now: NOW + 30_000 })
    expect(out.jkt).toBe(jwkThumbprint(await deviceKey.publicKey()))
    expect(out.jti).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(popHtu(`${URL_CHAT}?a=b`)).toBe(URL_CHAT)
  })

  it('refuses another method, URL, token, a stale proof or a forged signature', async () => {
    const deviceKey = SoftwareDeviceKeySigner.generate()
    const token = 'csa1:example'
    const proof = await createPopProof({ deviceKey, htm: 'POST', htu: URL_CHAT, token, now: NOW })
    const check = (over: Partial<{ token: string; htm: string; htu: string; now: number }>) =>
      verifyPopProof(proof, { token, htm: 'POST', htu: URL_CHAT, now: NOW, ...over })
    expect(() => check({ htm: 'GET' })).toThrow(PopProofError)
    expect(() => check({ htu: 'https://cofferdam.xyz/v1/chat/usage' })).toThrow(PopProofError)
    expect(() => check({ token: 'csa1:other' })).toThrow(PopProofError)
    expect(() => check({ now: NOW + 61_000 })).toThrow(PopProofError)

    const [h, p] = proof.split('.')
    const forged = await createPopProof({ deviceKey: SoftwareDeviceKeySigner.generate(), htm: 'POST', htu: URL_CHAT, token, now: NOW })
    expect(() => verifyPopProof(`${h}.${p}.${forged.split('.')[2]}`, { token, htm: 'POST', htu: URL_CHAT, now: NOW })).toThrow(
      PopProofError,
    )
  })
})

describe('cross-repo vector', () => {
  // Fixed keys and inputs; cofferdam-api asserts the same digest and thumbprint.
  it('pins the v2 digest and the RFC 7638 thumbprint', async () => {
    const deviceKey = new SoftwareDeviceKeySigner(new Uint8Array(32).fill(9))
    const passkey = new DeterministicPasskeySigner('vector-user')
    const jkt = jwkThumbprint(await deviceKey.publicKey())
    const digest = sessionAttestationV2Digest(await fields(deviceKey, { jkt }), await passkey.publicKey())
    expect({ jkt, digest: hexlify(digest) }).toMatchInlineSnapshot(`
      {
        "digest": "0xe2e1be400f26d5af47276a7aca381905e52d779e10fef262745fe766c262ab64",
        "jkt": "wn8-axFKnOFEnnaYJBgkGYUyDjm328I-jp-j7aegW-k",
      }
    `)
  })
})
