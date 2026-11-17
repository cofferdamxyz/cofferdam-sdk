// Builds the shared fixture of workspace decision 0086 (runbook
// `docs/runbooks/handles-build.md` step 1): `handleAnchorTypes.json`, which
// the anchor contract's tests (base-contracts, step 2) and the plane's tests
// (cofferdam-api, step 3) read to prove they agree with the SDK byte for
// byte. `handleFixture.test.ts` rebuilds it on every run and fails on any
// drift; `WRITE_HANDLE_FIXTURE=1 yarn test handleFixture` rewrites it.
//
// Every value is deterministic: fixed test keys (hashes of fixed strings, or
// derived from BIP-39's all-zero 24-word phrase), fixed messages, RFC 6979
// signatures. Never a real key.

import {
  computeAddress,
  getAddress,
  hexlify,
  id,
  keccak256,
  SigningKey,
  toUtf8Bytes,
  TypedDataEncoder,
  type TypedDataDomain,
} from 'ethers'
import {
  computeStealthPrivateKey,
  deriveHandleEpochKeys,
  deriveSelfAddress,
  deriveSelfEphemeralKey,
  FIXTURE_ONE_TIME_FACTORY,
  generateStealthAddress,
  HANDLE_ANCHOR_TYPES,
  HANDLE_REGISTRY_TYPES,
  HANDSHAKE_TYPES,
  handleAnchorDomain,
  handleId,
  handleRegistryDomain,
  handleTypedDataDigest,
  handleTypeString,
  handshakeDomain,
  phraseSeed,
  signHandleTypedData,
  type HandleAnchorPrimaryType,
  type HandlePrimaryType,
  type HandleRegistryPrimaryType,
} from '../../src/index.js'

export const FIXTURE_PHRASE = [...Array(23).fill('abandon'), 'art'].join(' ')
export const FIXTURE_CHAIN_ID = 84532
const testKey = (name: string): string => keccak256(toUtf8Bytes(`cofferdam-handles-0086-fixture:${name}`))
export const FIXTURE_ANCHOR_ADDRESS = getAddress('0x' + testKey('anchor').slice(26))

const hex = (b: Uint8Array): string => hexlify(b)

function typeEntry(primaryType: HandlePrimaryType): Record<string, unknown> {
  const fields = (HANDLE_ANCHOR_TYPES as Record<string, unknown>)[primaryType] ?? (HANDLE_REGISTRY_TYPES as Record<string, unknown>)[primaryType]
  const typeString = handleTypeString(primaryType)
  return { typeString, typeHash: id(typeString), fields }
}

function domainJson(d: TypedDataDomain): Record<string, unknown> {
  return { ...d, separator: TypedDataEncoder.hashDomain(d) }
}

/** The fixture object, exactly as `handleAnchorTypes.json` holds it. */
export function buildHandleFixture(): Record<string, unknown> {
  const seed = phraseSeed(FIXTURE_PHRASE)
  const e0 = deriveHandleEpochKeys(seed, 0)
  const e1 = deriveHandleEpochKeys(seed, 1)
  seed.fill(0)
  const registrarKey = testKey('registrar')
  const keys = {
    registrar: { privateKey: registrarKey, address: computeAddress(registrarKey), note: 'keccak256 of a fixed string' },
    owner: { privateKey: hex(e0.handleKey.privateKey), address: e0.handleKey.address, note: 'epoch 0 handle key of the fixture phrase' },
    newOwner: { privateKey: hex(e1.handleKey.privateKey), address: e1.handleKey.address, note: 'epoch 1 handle key of the fixture phrase' },
  }
  const anchorDomain = handleAnchorDomain(FIXTURE_CHAIN_ID, FIXTURE_ANCHOR_ADDRESS)
  const registryDomain = handleRegistryDomain(FIXTURE_CHAIN_ID)

  const ana = handleId('ana')
  const meta0 = hex(e0.metaAddress)
  const meta1 = hex(e1.metaAddress)
  const deadline = 1_900_000_000
  const frozenUntil = 1_800_000_000
  const expiresAt = 1_900_000_000
  const reqNonce = testKey('request-nonce')
  const selfAddr = deriveSelfAddress({ selfDerivationSeed: e0.selfDerivationSeed, metaAddress: e0.metaAddress, factory: FIXTURE_ONE_TIME_FACTORY, slot: 0, index: 0 })

  const anchorMessages: Array<[HandleAnchorPrimaryType, keyof typeof keys, Record<string, unknown>]> = [
    ['RegistrarClaim', 'registrar', { handleId: ana, owner: e0.handleKey.address, serial: 1, nonce: 0, deadline }],
    ['OwnerClaim', 'owner', { handleId: ana, metaAddress: meta0, serial: 1 }],
    ['TransferOwner', 'owner', { handleId: ana, newOwner: e1.handleKey.address, newMetaAddress: meta1, nonce: 1, deadline }],
    ['TransferOwnerAccept', 'newOwner', { handleId: ana, previousOwner: e0.handleKey.address, newMetaAddress: meta1, nonce: 1, deadline }],
    ['SetMetaAddress', 'owner', { handleId: ana, newMetaAddress: meta1, nonce: 1, deadline }],
    ['Release', 'owner', { handleId: ana, nonce: 1, deadline }],
    ['Cancel', 'owner', { handleId: ana, pendingNonce: 1, nonce: 2, deadline }],
    ['Advance', 'owner', { handleId: ana, newOwner: e1.handleKey.address, newMetaAddress: meta1, nonce: 1, deadline }],
    ['AdvanceAccept', 'newOwner', { handleId: ana, previousOwner: e0.handleKey.address, newMetaAddress: meta1, nonce: 1, deadline }],
    [
      'RegistrarAdvance',
      'registrar',
      { handleId: ana, previousOwner: e0.handleKey.address, newOwner: e1.handleKey.address, newMetaAddress: meta1, nonce: 1, deadline },
    ],
    ['Hold', 'registrar', { handleId: ana, nonce: 1, deadline }],
    ['RenewHold', 'registrar', { handleId: ana, frozenUntil, nonce: 2, deadline }],
    ['Veto', 'registrar', { handleId: ana, pendingNonce: 1, nonce: 2, deadline }],
    ['Unfreeze', 'owner', { handleId: ana, frozenUntil, nonce: 2, deadline }],
    ['RegistrarUnfreeze', 'registrar', { handleId: ana, frozenUntil, nonce: 2, deadline }],
  ]
  const registryMessages: Array<[HandleRegistryPrimaryType, keyof typeof keys, Record<string, unknown>]> = [
    ['RegistryClaim', 'owner', { label: 'ana', handleId: ana, owner: e0.handleKey.address, metaAddress: meta0, nonce: reqNonce, expiresAt }],
    ['SetDiscoverable', 'owner', { handleId: ana, serial: 1, discoverable: true, inboxId: 'a'.repeat(64), nonce: reqNonce, expiresAt }],
    [
      'RenameHandle',
      'owner',
      { handleId: ana, serial: 1, newLabel: 'ana-luz', newHandleId: handleId('ana-luz'), newOwner: e1.handleKey.address, newMetaAddress: meta1, nonce: reqNonce, expiresAt },
    ],
    ['ReleaseHandle', 'owner', { handleId: ana, serial: 1, nonce: reqNonce, expiresAt }],
    [
      'RegisterAddress',
      'owner',
      {
        handleId: ana,
        serial: 1,
        account: selfAddr.account,
        ephemeralPublicKey: hex(selfAddr.ephemeralPublicKey),
        sharedSecretHash: hex(selfAddr.sharedSecretHash),
        metaAddress: meta0,
        nonce: reqNonce,
        expiresAt,
      },
    ],
  ]
  const sign = (domainName: 'anchor' | 'registry', d: TypedDataDomain, [primaryType, who, message]: [HandlePrimaryType, keyof typeof keys, Record<string, unknown>]) => {
    const pk = Uint8Array.from(Buffer.from(keys[who].privateKey.slice(2), 'hex'))
    return {
      domain: domainName,
      primaryType,
      signer: who,
      signerAddress: keys[who].address,
      message,
      structHash: TypedDataEncoder.from({ [primaryType]: typeEntry(primaryType).fields as never }).hash(message),
      digest: handleTypedDataDigest(d, primaryType, message),
      signature: signHandleTypedData(pk, d, primaryType, message),
    }
  }

  // Stealth vectors: the fixture phrase's epoch-0 meta-address with three
  // fixed ephemeral keys, and two self-derived addresses.
  const stealthVectors = ['stealth-r-0', 'stealth-r-1', 'stealth-r-2'].map((name) => {
    const r = Uint8Array.from(Buffer.from(testKey(name).slice(2), 'hex'))
    const g = generateStealthAddress(e0.metaAddress, FIXTURE_ONE_TIME_FACTORY, r)
    const priv = computeStealthPrivateKey(e0.spendingKey.privateKey, e0.viewingKey.privateKey, g.ephemeralPublicKey)
    return {
      ephemeralPrivateKey: hex(r),
      ephemeralPublicKey: hex(g.ephemeralPublicKey),
      sharedSecretHash: hex(g.sharedSecretHash),
      viewTag: g.viewTag,
      signer: g.signer,
      signerPublicKey: new SigningKey(hex(priv.privateKey)).compressedPublicKey,
      stealthPrivateKey: hex(priv.privateKey),
      account: g.account,
    }
  })
  const selfVectors = [
    [0, 0],
    [3, 7],
  ].map(([slot, index]) => {
    const s = deriveSelfAddress({ selfDerivationSeed: e0.selfDerivationSeed, metaAddress: e0.metaAddress, factory: FIXTURE_ONE_TIME_FACTORY, slot: slot!, index: index! })
    return {
      slot,
      index,
      ephemeralPrivateKey: hex(deriveSelfEphemeralKey(e0.selfDerivationSeed, slot!, index!)),
      ephemeralPublicKey: hex(s.ephemeralPublicKey),
      sharedSecretHash: hex(s.sharedSecretHash),
      viewTag: s.viewTag,
      signer: s.signer,
      account: s.account,
    }
  })

  return {
    $comment: [
      'Shared fixture of workspace decision 0086 (runbook docs/runbooks/handles-build.md step 1), generated by',
      'cofferdam-sdk packages/core/test/fixtures/buildHandleFixture.ts; never edit by hand. Test keys only.',
      'Read by base-contracts (CofferdamHandleAnchor, step 2) and cofferdam-api (the registry, step 3).',
    ],
    version: 1,
    fields: {
      phrase: "BIP-39's 24-word all-zero-entropy phrase; every epoch key below derives from it (rootKeys + handleRoot).",
      chainId: 'Base Sepolia. The anchor domain also names verifyingContract, a placeholder address (keccak of a fixed string).',
      keys: 'registrar: keccak256("cofferdam-handles-0086-fixture:registrar"); owner and newOwner: the phrase\'s epoch 0 and 1 handle keys.',
      epochs: 'Per epoch: the handle key address (the anchor owner), the 66-byte meta-address (spending key then viewing key, compressed), the self-derivation seed.',
      handleIds: 'handleId = keccak256(utf8("cofferdam-handle-v1:" + label)), label in its stored ENSIP-15 form.',
      eip712: 'Per domain: the domain, its separator, and per primary type the canonical type string, keccak256 of it (typeHash) and the fields in order.',
      fieldConventions:
        'nonce (anchor): the anchor\'s one per-handle counter of accepted signed calls, read at signing; pendingNonce: the nonce at which the pending change was queued; deadline, frozenUntil, expiresAt: unix seconds; metaAddress: 66 bytes; nonce (registry): 32 random bytes, refused twice before expiresAt.',
      signed:
        'One message per primary type: the signing role, its address, the message, the EIP-712 structHash and digest, and the 65-byte signature r||s||v (v 27/28, low s, RFC 6979). Recovering the digest must give signerAddress.',
      stealth:
        'ERC-5564 scheme 1: R = r*G (compressed), h = keccak256(compressed r*V), viewTag = h[0], P = S + h*G, signer = address(P), stealthPrivateKey = s_spend + h mod n, account = CREATE2(factory.address, salt = signer left-padded to 32 bytes, factory.initCodeHash). The factory is the never-deployed placeholder until decision 0083 rule 4\'s exists.',
      selfDerived:
        'Self-derived addresses (0086 rule 1): r(p, i) = HKDF-SHA256(selfDerivationSeed, salt "cofferdam-root-keys-v1", info utf8("self-ephemeral") || u8 p || u32be i) mod n; then as stealth.',
    },
    phrase: FIXTURE_PHRASE,
    chainId: FIXTURE_CHAIN_ID,
    keys,
    epochs: [e0, e1].map((e) => ({
      epoch: e.epoch,
      owner: e.handleKey.address,
      metaAddress: hex(e.metaAddress),
      spendingPublicKey: hex(e.spendingKey.publicKey),
      viewingPublicKey: hex(e.viewingKey.publicKey),
      selfDerivationSeed: hex(e.selfDerivationSeed),
    })),
    handleIds: ['ana', 'ana-luz', 'abc', '0x0', 'a'.repeat(64)].map((label) => ({ label, handleId: handleId(label) })),
    eip712: {
      anchor: {
        domain: domainJson(anchorDomain),
        types: Object.fromEntries(Object.keys(HANDLE_ANCHOR_TYPES).map((t) => [t, typeEntry(t as HandlePrimaryType)])),
      },
      registry: {
        domain: domainJson(registryDomain),
        types: Object.fromEntries(Object.keys(HANDLE_REGISTRY_TYPES).map((t) => [t, typeEntry(t as HandlePrimaryType)])),
      },
      handshake: {
        domain: domainJson(handshakeDomain(FIXTURE_CHAIN_ID)),
        types: Object.fromEntries(
          Object.entries(HANDSHAKE_TYPES).map(([t, fields]) => {
            const typeString = `${t}(${fields.map((x) => `${x.type} ${x.name}`).join(',')})`
            return [t, { typeString, typeHash: id(typeString), fields }]
          }),
        ),
      },
    },
    signed: [
      ...anchorMessages.map((m) => sign('anchor', anchorDomain, m)),
      ...registryMessages.map((m) => sign('registry', registryDomain, m)),
    ],
    stealth: {
      schemeId: 1,
      factory: FIXTURE_ONE_TIME_FACTORY,
      metaAddress: meta0,
      spendingPrivateKey: hex(e0.spendingKey.privateKey),
      viewingPrivateKey: hex(e0.viewingKey.privateKey),
      vectors: stealthVectors,
      selfDerived: selfVectors,
    },
  }
}
