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
  DEVICE_HANDOFF_VERSION,
  type DeviceHandoff,
  type DeviceHandoffFields,
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

  it('binds a handoff to an invitation challenge when one is given', async () => {
    const challenge = '0x' + 'ab'.repeat(32)
    const h = await freshHandoff({ challenge })
    expect(h.challenge).toBe(challenge)
    const round = decodeAndVerifyDeviceHandoff(encodeDeviceHandoff(h))
    expect(round.challenge).toBe(challenge)
    // Changing the challenge breaks the liveness proof and a malformed one is refused.
    const swapped = { ...h, challenge: '0x' + 'cd'.repeat(32) }
    expect(() => verifyDeviceHandoff(swapped)).toThrow(DeviceHandoffLivenessError)
    expect(() => decodeDeviceHandoff(encodeDeviceHandoff({ ...h, challenge: '0x12' } as never))).toThrow(DeviceHandoffDecodeError)
    await expect(freshHandoff({ challenge: 'nope' })).rejects.toThrow(/challenge/)
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

// Version 2 (workspace decision 0081, step 5) carries the new device's X25519
// handover key. The vectors below are fixed: the v1 one was taken from the code
// before v2 existed, and both were recomputed with ethers' abi.encode outside
// this module, so a change to either layout fails here.
describe('device handoff v2 (handoverKey)', () => {
  const CHALLENGE = '0x' + 'cd'.repeat(32)
  const HANDOVER_KEY = '0x' + 'ef'.repeat(32)
  const FIELDS: DeviceHandoffFields = {
    credentialId: 'cred-abc123',
    publicKey: { qx: '0x' + '11'.repeat(32), qy: '0x' + '22'.repeat(32) },
    label: 'Pixel 7',
    ts: 1762800000000,
    deviceAccount: ACCOUNT_A,
  }
  const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex')
  const reencode = (h: DeviceHandoff, patch: Record<string, unknown>) => {
    const o: Record<string, unknown> = { ...h, ...patch }
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
    return 'cdh1:' + Buffer.from(JSON.stringify(o)).toString('base64url')
  }

  it('the newest version is 2 and the v1 digest is byte-identical to before', () => {
    expect(DEVICE_HANDOFF_VERSION).toBe(2)
    expect(hex(deviceHandoffDigest(FIELDS))).toBe(
      '0x04742787eb939025d7fbe1647518de502786bf7fce333c70f0432d4dc95d3bd8',
    )
    expect(hex(deviceHandoffDigest({ ...FIELDS, challenge: CHALLENGE }))).toBe(
      '0xfb4d54454629e5a813028d09fcb8c5ba1d67b7060dbc5b6cfd5a789b7da18ca3',
    )
  })

  it('v1 still verifies: a handoff created without handoverKey is v1 and round-trips', async () => {
    const h = await freshHandoff({ challenge: CHALLENGE })
    expect(h.v).toBe(1)
    expect(h.handoverKey).toBeUndefined()
    const round = decodeAndVerifyDeviceHandoff(encodeDeviceHandoff(h))
    expect(round.v).toBe(1)
    expect(round.handoverKey).toBeUndefined()
  })

  it('pins the v2 digest vector', () => {
    expect(hex(deviceHandoffDigest({ ...FIELDS, challenge: CHALLENGE, handoverKey: HANDOVER_KEY }))).toBe(
      '0x7cb3e8de41fe57c0f2135f9dc1fcacfcb4072d314d2ebd86346d12bd8798fcea',
    )
  })

  it('no v2 digest equals a v1 digest over the same challenge or over the key as challenge', () => {
    const v2 = hex(deviceHandoffDigest({ ...FIELDS, challenge: CHALLENGE, handoverKey: HANDOVER_KEY }))
    expect(v2).not.toBe(hex(deviceHandoffDigest({ ...FIELDS, challenge: CHALLENGE })))
    expect(v2).not.toBe(hex(deviceHandoffDigest({ ...FIELDS, challenge: HANDOVER_KEY })))
    expect(() => deviceHandoffDigest({ ...FIELDS, handoverKey: HANDOVER_KEY })).toThrow(DeviceHandoffError)
  })

  it('round-trips a v2 handoff with the handoverKey lowercased', async () => {
    const h = await freshHandoff({ challenge: CHALLENGE, handoverKey: '0x' + 'EF'.repeat(32) })
    expect(h.v).toBe(2)
    expect(h.handoverKey).toBe(HANDOVER_KEY)
    const round = decodeAndVerifyDeviceHandoff(encodeDeviceHandoff(h))
    expect(round.v).toBe(2)
    expect(round.handoverKey).toBe(HANDOVER_KEY)
    expect(round.challenge).toBe(CHALLENGE)
  })

  it('a tampered handoverKey fails the liveness proof', async () => {
    const h = await freshHandoff({ challenge: CHALLENGE, handoverKey: HANDOVER_KEY })
    const tampered: DeviceHandoff = { ...h, handoverKey: '0x' + '12'.repeat(32) }
    expect(() => verifyDeviceHandoff(tampered)).toThrow(DeviceHandoffLivenessError)
    const token = reencode(h, { handoverKey: '0x' + '12'.repeat(32) })
    expect(() => decodeAndVerifyDeviceHandoff(token)).toThrow(DeviceHandoffLivenessError)
  })

  it('a downgrade (handoverKey stripped, v set to 1) fails the liveness proof', async () => {
    const h = await freshHandoff({ challenge: CHALLENGE, handoverKey: HANDOVER_KEY })
    const token = reencode(h, { v: 1, handoverKey: undefined })
    const decoded = decodeDeviceHandoff(token)
    expect(decoded.v).toBe(1)
    expect(() => verifyDeviceHandoff(decoded)).toThrow(DeviceHandoffLivenessError)
  })

  it('refuses a version that disagrees with the handoverKey, an unknown version and a bad key', async () => {
    const h2 = await freshHandoff({ challenge: CHALLENGE, handoverKey: HANDOVER_KEY })
    const h1 = await freshHandoff({ challenge: CHALLENGE })
    expect(() => decodeDeviceHandoff(reencode(h2, { handoverKey: undefined }))).toThrow(DeviceHandoffDecodeError)
    expect(() => decodeDeviceHandoff(reencode(h1, { handoverKey: HANDOVER_KEY }))).toThrow(DeviceHandoffDecodeError)
    expect(() => decodeDeviceHandoff(reencode(h2, { v: 3 }))).toThrow(DeviceHandoffDecodeError)
    expect(() => decodeDeviceHandoff(reencode(h2, { handoverKey: '0x12' }))).toThrow(DeviceHandoffDecodeError)
    expect(() => decodeDeviceHandoff(reencode(h2, { challenge: undefined }))).toThrow(DeviceHandoffDecodeError)
    // An object built by hand gets the same check at verify time.
    expect(() => verifyDeviceHandoff({ ...h2, v: 1 })).toThrow(DeviceHandoffDecodeError)
    expect(() => verifyDeviceHandoff({ ...h1, v: 2 })).toThrow(DeviceHandoffDecodeError)
  })

  it('create refuses a malformed handoverKey and a handoverKey without a challenge', async () => {
    await expect(freshHandoff({ challenge: CHALLENGE, handoverKey: '0x12' })).rejects.toThrow(/handoverKey/)
    await expect(freshHandoff({ challenge: CHALLENGE, handoverKey: 'ef'.repeat(32) })).rejects.toThrow(/handoverKey/)
    await expect(freshHandoff({ handoverKey: HANDOVER_KEY })).rejects.toThrow(/challenge/)
  })

  it('a v2 token with a 64-character label fits a version-40 QR at ECC M (2,331 bytes)', async () => {
    const h = await freshHandoff({
      label: 'x'.repeat(MAX_DEVICE_LABEL_LENGTH),
      challenge: CHALLENGE,
      handoverKey: HANDOVER_KEY,
    })
    expect(encodeDeviceHandoff(h).length).toBeLessThan(2331)
  })
})
