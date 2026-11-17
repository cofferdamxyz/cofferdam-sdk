// The placeholder one-time account factory of the handle tests and of the
// shared fixture (workspace decision 0086 Ruling A, assumed): the address and
// the init code hash are keccak256 of fixed strings, so nothing is deployed
// there and an account under it can never be spent from. The plane and the
// anchor contract read the same values from handleAnchorTypes.json
// (`stealth.factory`). Decision 0083 rule 4's factory replaces it as a caller
// value; it never ships in the package.
import { getAddress, keccak256, toUtf8Bytes } from 'ethers'
import type { OneTimeAccountFactory } from '../../src/index.js'

export const FIXTURE_ONE_TIME_FACTORY: Readonly<OneTimeAccountFactory> = Object.freeze({
  address: getAddress('0x' + keccak256(toUtf8Bytes('cofferdam-fixture-one-time-factory-v0')).slice(26)),
  initCodeHash: keccak256(toUtf8Bytes('cofferdam-fixture-one-time-account-v0')),
})
