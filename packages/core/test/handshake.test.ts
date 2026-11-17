import { hexlify, Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  createHandshakeHalf,
  createHandshakeReply,
  createRenameNotice,
  decodeContactRecord,
  decodeHandshakeHalf,
  decodeRenameNotice,
  deriveHandshakeSecret,
  encodeContactRecord,
  encodeHandshakeHalf,
  encodeRenameNotice,
  HandshakeError,
  handshakeHalfDigest,
  verifyHandshakeHalf,
  verifyRenameNotice,
  type ContactRecord,
  type HandshakeAnchorView,
  type HandshakeHalf,
} from '../src/index.js'

const CHAIN = 84532
const NOW = 1_800_000_000_000
const key = () => {
  const w = Wallet.createRandom()
  return { pk: Buffer.from(w.privateKey.slice(2), 'hex') as Uint8Array, address: w.address }
}
const ana = key()
const bia = key()
const fresh = (): boolean => false
const anchorOf = (k: { address: string }, serial = 1): HandshakeAnchorView => ({ owner: k.address, serial, frozen: false, pendingChange: false })

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof HandshakeError ? e.code : `other: ${(e as Error).message}`
  }
  return 'none'
}

function pair() {
  const a = createHandshakeHalf({ handleKey: ana.pk, handle: 'ana', serial: 1, inboxId: 'inbox-ana', chainId: CHAIN, carrier: 'qr', now: NOW })
  const b = createHandshakeReply(a.half, { handleKey: bia.pk, handle: 'bia', serial: 2, inboxId: 'inbox-bia', chainId: CHAIN, carrier: 'link', now: NOW })
  return { a, b }
}

describe('handshake halves', () => {
  it('round-trip and check against the anchor', () => {
    const { a, b } = pair()
    const decoded = decodeHandshakeHalf(encodeHandshakeHalf(a.half))
    expect(decoded).toEqual(a.half)
    const check = verifyHandshakeHalf(decoded, { chainId: CHAIN, now: NOW, isReplay: fresh, anchor: anchorOf(ana), selfHandle: 'bia', carrier: 'qr' })
    expect(check.status).toBe('checked')
    expect(check.signer).toBe(ana.address)
    expect(b.half.peerHandle).toBe('ana')
    expect(b.half.replyTo).toBe(handshakeHalfDigest(a.half, CHAIN))
    expect(verifyHandshakeHalf(b.half, { chainId: CHAIN, now: NOW, isReplay: fresh, anchor: anchorOf(bia, 2), selfHandle: 'ana', inReplyTo: a.half }).status).toBe('checked')
    expect(a.half.expiresAt - NOW / 1000).toBe(600)
    expect(b.half.expiresAt - NOW / 1000).toBe(7 * 86400)
  })

  it('stays unchecked when scanned offline', () => {
    const { a } = pair()
    const check = verifyHandshakeHalf(a.half, { chainId: CHAIN, now: NOW, isReplay: fresh })
    expect(check.status).toBe('unchecked')
    expect(check.signer).toBe(ana.address)
  })

  it('refuses a forged, swapped or tampered half', () => {
    const { a } = pair()
    const mallory = key()
    const forged = createHandshakeHalf({ handleKey: mallory.pk, handle: 'ana', serial: 1, inboxId: 'inbox-mallory', chainId: CHAIN, carrier: 'qr', now: NOW })
    expect(code(() => verifyHandshakeHalf(forged.half, { chainId: CHAIN, now: NOW, isReplay: fresh, anchor: anchorOf(ana) }))).toBe('owner-mismatch')
    const tampered: HandshakeHalf = { ...a.half, inboxId: 'inbox-mallory' }
    expect(code(() => verifyHandshakeHalf(tampered, { chainId: CHAIN, now: NOW, isReplay: fresh, anchor: anchorOf(ana) }))).toBe('owner-mismatch')
    const otherChain = verifyHandshakeHalf(a.half, { chainId: 8453, now: NOW, isReplay: fresh })
    expect(otherChain.signer).not.toBe(ana.address)
    expect(code(() => verifyHandshakeHalf({ ...a.half, handleId: '0x' + '11'.repeat(32) }, { chainId: CHAIN, now: NOW, isReplay: fresh }))).toBe('malformed')
    expect(code(() => verifyHandshakeHalf({ ...a.half, signature: '0x' + '00'.repeat(65) }, { chainId: CHAIN, now: NOW, isReplay: fresh }))).toBe('bad-signature')
  })

  it('refuses an expired, overlong or replayed half', () => {
    const { a, b } = pair()
    expect(code(() => verifyHandshakeHalf(a.half, { chainId: CHAIN, now: NOW + 601_000, isReplay: fresh }))).toBe('expired')
    expect(code(() => verifyHandshakeHalf(b.half, { chainId: CHAIN, now: NOW, isReplay: fresh, carrier: 'qr' }))).toBe('lifetime')
    expect(code(() => verifyHandshakeHalf(b.half, { chainId: CHAIN, now: NOW - 86400_000, isReplay: fresh }))).toBe('lifetime')
    const seen = new Set<string>()
    const isReplay = (n: string) => seen.has(n)
    verifyHandshakeHalf(a.half, { chainId: CHAIN, now: NOW, isReplay })
    seen.add(a.half.nonce)
    expect(code(() => verifyHandshakeHalf(a.half, { chainId: CHAIN, now: NOW, isReplay }))).toBe('replayed')
  })

  it('refuses a frozen record, a pending change, a new serial and the wrong peer or reply', () => {
    const { a, b } = pair()
    const opts = { chainId: CHAIN, now: NOW, isReplay: fresh }
    expect(code(() => verifyHandshakeHalf(a.half, { ...opts, anchor: { ...anchorOf(ana), frozen: true } }))).toBe('frozen')
    expect(code(() => verifyHandshakeHalf(a.half, { ...opts, anchor: { ...anchorOf(ana), pendingChange: true } }))).toBe('pending-change')
    expect(code(() => verifyHandshakeHalf(a.half, { ...opts, anchor: anchorOf(ana, 2) }))).toBe('serial-mismatch')
    expect(code(() => verifyHandshakeHalf(b.half, { ...opts, selfHandle: 'cai' }))).toBe('wrong-peer')
    const other = createHandshakeHalf({ handleKey: ana.pk, handle: 'ana', serial: 1, inboxId: 'inbox-ana', chainId: CHAIN, carrier: 'qr', now: NOW })
    expect(code(() => verifyHandshakeHalf(b.half, { ...opts, inReplyTo: other.half }))).toBe('wrong-reply')
  })

  it('refuses malformed input without throwing anything else', () => {
    const { a } = pair()
    for (const text of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ ...a.half, extra: 1 }),
      JSON.stringify({ ...a.half, v: 2 }),
      JSON.stringify({ ...a.half, handle: 'Ana' }),
      JSON.stringify({ ...a.half, serial: -1 }),
      JSON.stringify({ ...a.half, serial: '1' }),
      JSON.stringify({ ...a.half, ephemeralKey: a.half.ephemeralKey.toUpperCase() }),
      JSON.stringify({ ...a.half, replyTo: '0x' + '00'.repeat(32) }),
      JSON.stringify({ ...a.half, inboxId: '' }),
      JSON.stringify({ ...a.half, peerHandle: 'x' }),
    ]) {
      expect(code(() => decodeHandshakeHalf(text)), text.slice(0, 40)).toBe('malformed')
    }
  })
})

describe('the pairwise secret', () => {
  it('is the same on both phones and never on the wire', () => {
    const { a, b } = pair()
    const sa = deriveHandshakeSecret({ ephemeralPrivateKey: a.ephemeralPrivateKey, first: a.half, reply: b.half, chainId: CHAIN })
    const sb = deriveHandshakeSecret({ ephemeralPrivateKey: b.ephemeralPrivateKey, first: a.half, reply: b.half, chainId: CHAIN })
    expect(sa.length).toBe(32)
    expect(hexlify(sa)).toBe(hexlify(sb))
    const wire = encodeHandshakeHalf(a.half) + encodeHandshakeHalf(b.half)
    expect(wire).not.toContain(hexlify(sa).slice(2))
  })

  it('differs per handshake and refuses a key or reply that does not belong', () => {
    const p1 = pair()
    const p2 = pair()
    const s1 = deriveHandshakeSecret({ ephemeralPrivateKey: p1.a.ephemeralPrivateKey, first: p1.a.half, reply: p1.b.half, chainId: CHAIN })
    const s2 = deriveHandshakeSecret({ ephemeralPrivateKey: p2.a.ephemeralPrivateKey, first: p2.a.half, reply: p2.b.half, chainId: CHAIN })
    expect(hexlify(s1)).not.toBe(hexlify(s2))
    expect(code(() => deriveHandshakeSecret({ ephemeralPrivateKey: p2.a.ephemeralPrivateKey, first: p1.a.half, reply: p1.b.half, chainId: CHAIN }))).toBe('malformed')
    expect(code(() => deriveHandshakeSecret({ ephemeralPrivateKey: p1.a.ephemeralPrivateKey, first: p1.a.half, reply: p2.b.half, chainId: CHAIN }))).toBe('wrong-reply')
  })

  it('refuses a low-order X25519 key', () => {
    const { a, b } = pair()
    const zero = { ...b.half, ephemeralKey: '0x' + '00'.repeat(32) }
    expect(code(() => deriveHandshakeSecret({ ephemeralPrivateKey: a.ephemeralPrivateKey, first: a.half, reply: zero, chainId: CHAIN }))).toBe('malformed')
  })
})

describe('rename notices', () => {
  const next = key()
  const make = () =>
    createRenameNotice({
      oldHandleKey: ana.pk,
      newHandleKey: next.pk,
      oldHandle: 'ana',
      oldSerial: 1,
      newHandle: 'ana-luz',
      newSerial: 1,
      identityStatement: 'plane-statement',
      chainId: CHAIN,
      now: NOW,
    })

  it('carry both keys’ signatures and round-trip', () => {
    const n = make()
    expect(n.oldOwner).toBe(ana.address)
    expect(n.newOwner).toBe(next.address)
    const d = decodeRenameNotice(encodeRenameNotice(n))
    expect(d).toEqual(n)
    expect(() => verifyRenameNotice(d, CHAIN)).not.toThrow()
  })

  it('refuse a notice with a missing or swapped signature', () => {
    const n = make()
    expect(code(() => verifyRenameNotice({ ...n, newSignature: n.oldSignature }, CHAIN))).toBe('bad-signature')
    expect(code(() => verifyRenameNotice({ ...n, newOwner: key().address }, CHAIN))).toBe('bad-signature')
    expect(code(() => verifyRenameNotice(n, 8453))).toBe('bad-signature')
    expect(code(() => verifyRenameNotice({ ...n, newHandleId: n.oldHandleId }, CHAIN))).toBe('malformed')
    expect(code(() => decodeRenameNotice(JSON.stringify({ ...n, identityStatement: '' })))).toBe('malformed')
  })
})

describe('contact records', () => {
  const { a, b } = pair()
  const record: ContactRecord = {
    v: 1,
    handle: 'ana',
    handleId: a.half.handleId,
    serial: 1,
    ownerAtHandshake: ana.address,
    inboxId: 'inbox-ana',
    pairwiseSecret: deriveHandshakeSecret({ ephemeralPrivateKey: b.ephemeralPrivateKey, first: a.half, reply: b.half, chainId: CHAIN }),
    path: 'in-person',
    receipt: { first: a.half, reply: b.half },
    filterReceived: new Uint8Array(600).fill(7),
    name: 'Ana',
    avatar: null,
    sharesContacts: false,
    createdAt: NOW,
  }

  it('round-trip', () => {
    expect(decodeContactRecord(encodeContactRecord(record))).toEqual(record)
    expect(decodeContactRecord(encodeContactRecord({ ...record, filterReceived: null }))).toEqual({ ...record, filterReceived: null })
  })

  it('hold no address field and refuse one added', () => {
    const json = JSON.parse(new TextDecoder().decode(encodeContactRecord(record)))
    expect(Object.keys(json)).not.toContain('address')
    const withAddress = new TextEncoder().encode(JSON.stringify({ ...json, address: ana.address }))
    expect(code(() => decodeContactRecord(withAddress))).toBe('malformed')
  })

  it('refuse a wrong type, path, handleId or secret', () => {
    const json = JSON.parse(new TextDecoder().decode(encodeContactRecord(record)))
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
    for (const bad of [
      { ...json, path: 'phonebook' },
      { ...json, handleId: b.half.handleId },
      { ...json, pairwiseSecret: '0x1234' },
      { ...json, sharesContacts: 'no' },
      { ...json, createdAt: -1 },
      { ...json, ownerAtHandshake: ana.address.toLowerCase() },
      { ...json, receipt: { first: json.receipt.first } },
      { ...json, v: 2 },
    ]) {
      expect(code(() => decodeContactRecord(enc(bad)))).toBe('malformed')
    }
    expect(code(() => decodeContactRecord(new Uint8Array([0xff, 0xfe])))).toBe('malformed')
    expect(code(() => encodeContactRecord({ ...record, path: 'phonebook' as any }))).toBe('malformed')
  })
})
