// Builds the shared fixture of workspace decision 0090 item 5:
// `ceremonyTypes.json`, which the account contract's tests (base-contracts),
// the attester's tests and the plane's tests read to prove they agree with
// the SDK byte for byte. `ceremonyFixture.test.ts` rebuilds it on every run
// and fails on any drift; `WRITE_CEREMONY_FIXTURE=1 yarn test ceremonyFixture`
// rewrites it.
//
// Every value is deterministic: fixed test keys and addresses (hashes of fixed
// strings), fixed messages, RFC 6979 signatures. Never a real key or address.

import { computeAddress, getAddress, id, keccak256, toUtf8Bytes, TypedDataEncoder } from 'ethers'
import {
  CEREMONY_ACTIONS,
  CEREMONY_DOMAIN_NAME,
  CEREMONY_DOMAIN_VERSION,
  CEREMONY_PRIMARY_TYPE,
  CEREMONY_TYPEHASH,
  CEREMONY_TYPE_STRING,
  CEREMONY_TYPES,
  ceremonyDigest,
  ceremonyDomain,
  signCeremonyAttestation,
  type CeremonyAction,
  type CeremonyAttestationMessage,
} from '../../src/identity/ceremony.js'

const addressOf = (label: string): string => getAddress('0x' + keccak256(toUtf8Bytes(label)).slice(26))

export function buildCeremonyFixture(): Record<string, unknown> {
  const attesterKey = keccak256(toUtf8Bytes('cofferdam-ceremony-fixture-attester'))
  const pk = Uint8Array.from(Buffer.from(attesterKey.slice(2), 'hex'))
  const cases: Array<{ chainId: number; registry: string; action: CeremonyAction; message: Omit<CeremonyAttestationMessage, 'action'> }> = [
    {
      chainId: 8453,
      registry: addressOf('cofferdam-ceremony-fixture-registry-mainnet'),
      action: 'enroll-first-high',
      message: {
        account: addressOf('cofferdam-ceremony-fixture-account-a'),
        newKeyHash: keccak256(toUtf8Bytes('fixture new High config')),
        partnerId: id('offshoresync'),
        nonce: 0n,
        notBefore: 1_800_000_000n,
        expiry: 1_800_000_600n,
      },
    },
    {
      chainId: 84532,
      registry: addressOf('cofferdam-ceremony-fixture-registry-sepolia'),
      action: 'replace-partner',
      message: {
        account: addressOf('cofferdam-ceremony-fixture-account-b'),
        newKeyHash: keccak256(toUtf8Bytes('fixture new Partner config')),
        partnerId: id('offshoresync'),
        nonce: 3n,
        notBefore: 1_800_000_000n,
        expiry: 1_800_003_600n,
      },
    },
    {
      chainId: 8453,
      registry: addressOf('cofferdam-ceremony-fixture-registry-mainnet'),
      action: 'recover-high',
      message: {
        account: addressOf('cofferdam-ceremony-fixture-account-a'),
        newKeyHash: keccak256(toUtf8Bytes('fixture recovered High config')),
        partnerId: '0x' + '00'.repeat(32),
        nonce: (1n << 255n) + 7n,
        notBefore: (1n << 48n) - 601n,
        expiry: (1n << 48n) - 1n,
      },
    },
  ]
  const vectors = cases.map((c) => {
    const domain = ceremonyDomain(c.chainId, c.registry)
    const message: CeremonyAttestationMessage = { ...c.message, action: CEREMONY_ACTIONS[c.action] }
    const types = { CeremonyAttestation: [...CEREMONY_TYPES.CeremonyAttestation] }
    return {
      actionName: c.action,
      domain: { name: CEREMONY_DOMAIN_NAME, version: CEREMONY_DOMAIN_VERSION, chainId: c.chainId, verifyingContract: c.registry },
      message: {
        ...message,
        nonce: message.nonce.toString(),
        notBefore: message.notBefore.toString(),
        expiry: message.expiry.toString(),
      },
      domainSeparator: TypedDataEncoder.hashDomain(domain),
      structHash: TypedDataEncoder.hashStruct(CEREMONY_PRIMARY_TYPE, types, message),
      digest: ceremonyDigest(domain, message),
      signature: signCeremonyAttestation(pk, domain, message),
      signerAddress: computeAddress(attesterKey),
    }
  })
  return {
    note: 'workspace decision 0090 item 5; built by cofferdam-sdk packages/core/test/fixtures/buildCeremonyFixture.ts, never edited by hand',
    domain: { name: CEREMONY_DOMAIN_NAME, version: CEREMONY_DOMAIN_VERSION },
    primaryType: CEREMONY_PRIMARY_TYPE,
    typeString: CEREMONY_TYPE_STRING,
    typehash: CEREMONY_TYPEHASH,
    fields: CEREMONY_TYPES.CeremonyAttestation,
    actions: CEREMONY_ACTIONS,
    attester: { privateKey: attesterKey, address: computeAddress(attesterKey), note: 'keccak256 of a fixed string; never a real key' },
    vectors,
  }
}
