// Unit tests for the passkey-signed session-attestation codec. Pure: no chain,
// no network. Exercises BOTH signature schemes — the raw-P256
// `DeterministicPasskeySigner` and the WebAuthn-assertion `WebAuthnPasskeySigner`
// (via the in-memory software authenticator) — so a verifier can check either.

import { describe, it, expect } from 'vitest'
import {
  DeterministicPasskeySigner,
  WebAuthnPasskeySigner,
  softwareWebAuthnAuthenticator,
  softwareWebAuthnPublicKey,
  createSessionAttestation,
  signSessionAttestation,
  encodeSessionAttestation,
  decodeSessionAttestation,
  verifySessionAttestation,
  decodeAndVerifySessionAttestation,
  sessionAttestationDigest,
  SessionAttestationDecodeError,
  SessionAttestationExpiredError,
  SessionAttestationVerificationError,
  type PasskeySigner,
  type SessionAttestation,
  type SessionAttestationFields,
} from '../src/index.js'

const ACCOUNT_A = '0x' + 'ab'.repeat(20)
const ACCOUNT_B = '0x' + 'cd'.repeat(20)

const FIELDS: SessionAttestationFields = {
  scope: 'offshoresync',
  appPseudonym: 'cd_pseudo_0123456789abcdef01234567',
  accountAddress: ACCOUNT_A,
  chainId: 300,
  verified: true,
  issuedAt: 1_781_000_000_000,
}

function webauthnSigner(fillByte = 7): PasskeySigner {
  const priv = new Uint8Array(32).fill(fillByte)
  return new WebAuthnPasskeySigner(softwareWebAuthnPublicKey(priv), softwareWebAuthnAuthenticator(priv))
}

function p256Signer(userId = 'attestation-user'): PasskeySigner {
  return new DeterministicPasskeySigner(userId)
}

const SIGNERS: Array<[string, () => PasskeySigner]> = [
  ['p256 (DeterministicPasskeySigner)', () => p256Signer()],
  ['webauthn (WebAuthnPasskeySigner)', () => webauthnSigner()],
]

describe('session attestation codec', () => {
  for (const [label, mk] of SIGNERS) {
    describe(label, () => {
      it('round-trips create → encode → decode → verify', async () => {
        const signer = mk()
        const att = await createSessionAttestation({ signer, fields: FIELDS })
        const token = encodeSessionAttestation(att)
        expect(token.startsWith('csa1:')).toBe(true)
        expect(att.alg).toBe(signer.scheme)
        expect(att.publicKey).toEqual(await signer.publicKey())

        const decoded = decodeSessionAttestation(token)
        expect(decoded.scope).toBe(FIELDS.scope)
        expect(decoded.appPseudonym).toBe(FIELDS.appPseudonym)
        expect(decoded.accountAddress).toBe(ACCOUNT_A)
        expect(decoded.chainId).toBe(300)
        expect(decoded.verified).toBe(true)
        expect(decoded.sig).toBe(att.sig)

        expect(() => verifySessionAttestation(decoded)).not.toThrow()
        expect(decodeAndVerifySessionAttestation(token)).toMatchObject({ scope: FIELDS.scope })
      })

      it('verifies against pinned expectations', async () => {
        const token = await signSessionAttestation({ signer: mk(), fields: FIELDS })
        expect(() =>
          decodeAndVerifySessionAttestation(token, {
            expect: { scope: 'offshoresync', accountAddress: ACCOUNT_A.toUpperCase(), chainId: 300 },
          }),
        ).not.toThrow()
      })

      it('rejects a mismatched expectation', async () => {
        const token = await signSessionAttestation({ signer: mk(), fields: FIELDS })
        expect(() =>
          decodeAndVerifySessionAttestation(token, { expect: { scope: 'other-app' } }),
        ).toThrow(SessionAttestationVerificationError)
        expect(() =>
          decodeAndVerifySessionAttestation(token, { expect: { accountAddress: ACCOUNT_B } }),
        ).toThrow(SessionAttestationVerificationError)
      })

      it('rejects a tampered field (signature breaks)', async () => {
        const att = await createSessionAttestation({ signer: mk(), fields: FIELDS })
        const tampered: SessionAttestation = { ...att, accountAddress: ACCOUNT_B }
        expect(() => verifySessionAttestation(tampered)).toThrow(SessionAttestationVerificationError)
        const tamperedPseudonym: SessionAttestation = { ...att, appPseudonym: 'cd_pseudo_ffffffffffffffffffffffff' }
        expect(() => verifySessionAttestation(tamperedPseudonym)).toThrow(SessionAttestationVerificationError)
      })

      it('rejects a swapped public key', async () => {
        const att = await createSessionAttestation({ signer: mk(), fields: FIELDS })
        const otherPub = await webauthnSigner(9).publicKey()
        const tampered: SessionAttestation = { ...att, publicKey: otherPub }
        expect(() => verifySessionAttestation(tampered)).toThrow(SessionAttestationVerificationError)
      })

      it('enforces freshness only when maxAgeMs is set', async () => {
        const stale = await createSessionAttestation({
          signer: mk(),
          fields: { ...FIELDS, issuedAt: Date.now() - 10 * 60_000 },
        })
        expect(() => verifySessionAttestation(stale, { maxAgeMs: 5 * 60_000 })).toThrow(
          SessionAttestationExpiredError,
        )
        // Default (maxAgeMs 0) skips the freshness check but still verifies the sig.
        expect(() => verifySessionAttestation(stale)).not.toThrow()
      })
    })
  }

  it('the digest commits to every field', () => {
    const pub = { qx: '0x' + '11'.repeat(32), qy: '0x' + '22'.repeat(32) }
    const base = sessionAttestationDigest(FIELDS, pub)
    const changedScope = sessionAttestationDigest({ ...FIELDS, scope: 'x' }, pub)
    const changedAccount = sessionAttestationDigest({ ...FIELDS, accountAddress: ACCOUNT_B }, pub)
    const changedVerified = sessionAttestationDigest({ ...FIELDS, verified: false }, pub)
    const changedKey = sessionAttestationDigest(FIELDS, { qx: '0x' + '33'.repeat(32), qy: pub.qy })
    expect(Buffer.from(base)).not.toEqual(Buffer.from(changedScope))
    expect(Buffer.from(base)).not.toEqual(Buffer.from(changedAccount))
    expect(Buffer.from(base)).not.toEqual(Buffer.from(changedVerified))
    expect(Buffer.from(base)).not.toEqual(Buffer.from(changedKey))
  })

  it('rejects malformed tokens at decode time', () => {
    expect(() => decodeSessionAttestation('not-a-cofferdam-token')).toThrow(SessionAttestationDecodeError)
    expect(() => decodeSessionAttestation('csa1:%%%not-base64%%%')).toThrow(SessionAttestationDecodeError)
    expect(() => decodeSessionAttestation('csa1:' + Buffer.from('{"v":1}').toString('base64url'))).toThrow(
      SessionAttestationDecodeError,
    )
  })

  it('a p256 attestation does not verify as webauthn (and vice-versa)', async () => {
    const p256Att = await createSessionAttestation({ signer: p256Signer(), fields: FIELDS })
    const asWebauthn: SessionAttestation = { ...p256Att, alg: 'webauthn' }
    expect(() => verifySessionAttestation(asWebauthn)).toThrow(SessionAttestationVerificationError)

    const webauthnAtt = await createSessionAttestation({ signer: webauthnSigner(), fields: FIELDS })
    const asP256: SessionAttestation = { ...webauthnAtt, alg: 'p256' }
    expect(() => verifySessionAttestation(asP256)).toThrow(SessionAttestationVerificationError)
  })
})
