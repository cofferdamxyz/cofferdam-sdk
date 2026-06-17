// Unit tests for the air-gapped device-handoff QR codec (ARCHITECTURE.md
// §3.6.4 Step A). Pure: no chain, no network — uses the software WebAuthn
// authenticator to mint real assertions over the handoff digest.

import { describe, it, expect } from 'vitest'
import {
  WebAuthnPasskeySigner,
  softwareWebAuthnAuthenticator,
  softwareWebAuthnPublicKey,
  createDeviceHandoff,
  encodeDeviceHandoff,
  decodeDeviceHandoff,
  verifyDeviceHandoff,
  decodeAndVerifyDeviceHandoff,
  deviceHandoffDigest,
  DeviceHandoffDecodeError,
  DeviceHandoffExpiredError,
  DeviceHandoffLivenessError,
  DeviceHandoffError,
  MAX_DEVICE_LABEL_LENGTH,
  type DeviceHandoff,
} from '../src/index.js'

const ACCOUNT_A = '0x' + 'ab'.repeat(20)
const ACCOUNT_B = '0x' + 'cd'.repeat(20)

function mkSigner(fillByte: number) {
  const priv = new Uint8Array(32).fill(fillByte)
  const pub = softwareWebAuthnPublicKey(priv)
  const signer = new WebAuthnPasskeySigner(pub, softwareWebAuthnAuthenticator(priv))
  return { priv, pub, signer }
}

async function freshHandoff(overrides: Partial<Parameters<typeof createDeviceHandoff>[0]> = {}) {
  const { signer } = mkSigner(7)
  return createDeviceHandoff({
    signer,
    credentialId: 'cred-abc123',
    label: 'Pixel 7',
    deviceAccount: ACCOUNT_A,
    ...overrides,
  })
}

describe('device handoff codec', () => {
  it('round-trips create → encode → decode → verify', async () => {
    const handoff = await freshHandoff()
    const token = encodeDeviceHandoff(handoff)
    expect(token.startsWith('cdh1:')).toBe(true)

    const decoded = decodeDeviceHandoff(token)
    expect(decoded.credentialId).toBe('cred-abc123')
    expect(decoded.label).toBe('Pixel 7')
    expect(decoded.deviceAccount).toBe(ACCOUNT_A)
    expect(decoded.publicKey).toEqual(handoff.publicKey)
    expect(decoded.livenessSig).toBe(handoff.livenessSig)

    // The canonical device verifies the liveness proof without throwing.
    expect(() => verifyDeviceHandoff(decoded)).not.toThrow()
    expect(decodeAndVerifyDeviceHandoff(token)).toMatchObject({ credentialId: 'cred-abc123' })
  })

  it('the digest commits to every field', async () => {
    const handoff = await freshHandoff()
    const base = deviceHandoffDigest(handoff)
    const changedLabel = deviceHandoffDigest({ ...handoff, label: 'Pixel 8' })
    const changedAccount = deviceHandoffDigest({ ...handoff, deviceAccount: ACCOUNT_B })
    expect(Buffer.from(base)).not.toEqual(Buffer.from(changedLabel))
    expect(Buffer.from(base)).not.toEqual(Buffer.from(changedAccount))
  })

  it('rejects a tampered label (liveness proof breaks)', async () => {
    const handoff = await freshHandoff()
    const tampered: DeviceHandoff = { ...handoff, label: 'Attacker Device' }
    expect(() => verifyDeviceHandoff(tampered)).toThrow(DeviceHandoffLivenessError)
  })

  it('rejects a swapped public key', async () => {
    const handoff = await freshHandoff()
    const other = mkSigner(9).pub
    const tampered: DeviceHandoff = { ...handoff, publicKey: other }
    expect(() => verifyDeviceHandoff(tampered)).toThrow(DeviceHandoffLivenessError)
  })

  it('rejects a swapped deviceAccount', async () => {
    const handoff = await freshHandoff()
    const tampered: DeviceHandoff = { ...handoff, deviceAccount: ACCOUNT_B }
    expect(() => verifyDeviceHandoff(tampered)).toThrow(DeviceHandoffLivenessError)
  })

  it('rejects a stale QR (replay window)', async () => {
    const handoff = await freshHandoff({ ts: Date.now() - 10 * 60_000 })
    expect(() => verifyDeviceHandoff(handoff)).toThrow(DeviceHandoffExpiredError)
    // maxAgeMs: 0 disables the freshness check (still verifies liveness).
    expect(() => verifyDeviceHandoff(handoff, { maxAgeMs: 0 })).not.toThrow()
  })

  it('rejects a future-dated QR beyond clock skew', async () => {
    const handoff = await freshHandoff({ ts: Date.now() + 5 * 60_000 })
    expect(() => verifyDeviceHandoff(handoff)).toThrow(DeviceHandoffExpiredError)
  })

  it('rejects malformed tokens at decode time', () => {
    expect(() => decodeDeviceHandoff('not-a-cofferdam-qr')).toThrow(DeviceHandoffDecodeError)
    expect(() => decodeDeviceHandoff('cdh1:%%%not-base64%%%')).toThrow(DeviceHandoffDecodeError)
    expect(() => decodeDeviceHandoff('cdh1:' + Buffer.from('{"v":1}').toString('base64url'))).toThrow(
      DeviceHandoffDecodeError,
    )
  })

  it('validates inputs when creating a handoff', async () => {
    const { signer } = mkSigner(7)
    await expect(
      createDeviceHandoff({ signer, credentialId: 'c', label: '', deviceAccount: ACCOUNT_A }),
    ).rejects.toThrow(DeviceHandoffError)
    await expect(
      createDeviceHandoff({ signer, credentialId: 'c', label: 'x'.repeat(MAX_DEVICE_LABEL_LENGTH + 1), deviceAccount: ACCOUNT_A }),
    ).rejects.toThrow(DeviceHandoffError)
    await expect(
      createDeviceHandoff({ signer, credentialId: 'c', label: 'ok', deviceAccount: '0xnotanaddress' }),
    ).rejects.toThrow(DeviceHandoffError)
  })
})
