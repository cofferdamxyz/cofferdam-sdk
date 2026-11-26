// The escrow clients' human-readable ABIs against base-contracts' compiled
// artifacts: every function and event the SDK declares must exist there with
// the same selector or topic (flexible-currency escrows, workspace decision
// 0100 question 7: the factory takes the escrow's token). The artifacts sit in
// the sibling checkout on the Mac (`base-contracts/artifacts/`, ignored by
// git, written by `yarn compile` with the enterprise submodule); without them
// this test is skipped, as in a cloud clone.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Interface } from 'ethers'
import { COFFERDAM_ESCROW_FACTORY_ABI } from '../src/escrow/CofferdamEscrowFactoryClient'
import { COFFERDAM_SPOT_ESCROW_ABI } from '../src/escrow/CofferdamSpotEscrowClient'

const ARTIFACTS = join(__dirname, '..', '..', '..', '..', 'base-contracts', 'artifacts', 'contracts', 'enterprise', 'escrow')

function artifact(name: string): Interface | null {
  const file = join(ARTIFACTS, `${name}.sol`, `${name}.json`)
  if (!existsSync(file)) return null
  return new Interface((JSON.parse(readFileSync(file, 'utf8')) as { abi: unknown[] }).abi as string[])
}

function mismatches(sdk: Interface, compiled: Interface): string[] {
  const missing: string[] = []
  sdk.forEachFunction((f) => {
    if (!compiled.getFunction(f.selector)) missing.push(`function ${f.format()}`)
  })
  sdk.forEachEvent((e) => {
    if (!compiled.getEvent(e.topicHash)) missing.push(`event ${e.format()}`)
  })
  return missing
}

const factory = artifact('EscrowFactory')
const spot = artifact('CofferdamSpotEscrow')

describe.skipIf(!factory || !spot)('escrow ABIs match base-contracts', () => {
  it('the factory client declares only functions and events the factory has', () => {
    expect(mismatches(new Interface(COFFERDAM_ESCROW_FACTORY_ABI as unknown as string[]), factory!)).toEqual([])
  })

  it('the spot escrow client declares only functions and events the escrow has', () => {
    expect(mismatches(new Interface(COFFERDAM_SPOT_ESCROW_ABI as unknown as string[]), spot!)).toEqual([])
  })

  it('the factory takes the token first and has no fixed USDC', () => {
    const create = factory!.getFunction('createSpotEscrow')!
    expect(create.inputs[0]).toMatchObject({ name: '_token', type: 'address' })
    expect(factory!.getFunction('USDC')).toBeNull()
  })
})
