// listAuthorities against a fake JSON-RPC node: no chain, no deployer key.
//
// The node answers only what `NativeAccountProvider.listAuthorities` reads:
// eth_chainId, eth_getCode and the account's authorityCount / getAuthority /
// probationEndsAt views. It checks the Partner tier is listed (it used to be
// skipped), each High's probationEndsAt is read, and Tier.None slots stay out.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Interface } from 'ethers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NativeAccountProvider } from '../src/index.js'

const ACCOUNT = '0x80967a159A00dcabe2DeAF86b68249acfc45C265'
const FACTORY = '0x35CeBf87f5DAE7be7cf755067d30fC65Fa541F3D'
const HIGH_MODULE = '0x279Cf7DF840a76EE9EcC1C177698E6EaB490Eea8'
const PARTNER_MODULE = '0xf1a9E1c2411DeaBA6F45630754dB1824779eC129'
const ZERO = '0x0000000000000000000000000000000000000000'
const PROBATION_END = 1_900_000_000

const iface = new Interface([
  'function authorityCount() view returns (uint256)',
  'function getAuthority(uint256 authorityId) view returns (address module, uint8 tier, bool active, bytes config)',
  'function probationEndsAt(uint256 authorityId) view returns (uint48)',
])

const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const HIGH_CONFIG_0 = `${word(1)}${word(2).slice(2)}`
const HIGH_CONFIG_1 = `${word(3)}${word(4).slice(2)}`
const PARTNER_CONFIG = `${word(5)}${word(6).slice(2)}${word(7).slice(2)}${word(8).slice(2)}${word(9).slice(2)}`

/** On-chain registry: two Highs (the second on probation), a Partner, an empty slot. */
const AUTHORITIES: Record<number, [string, number, boolean, string]> = {
  0: [HIGH_MODULE, 3, true, HIGH_CONFIG_0],
  1: [HIGH_MODULE, 3, true, HIGH_CONFIG_1],
  2: [PARTNER_MODULE, 4, true, PARTNER_CONFIG],
  3: [ZERO, 0, false, '0x'],
}

function answer(method: string, params: unknown[]): unknown {
  if (method === 'eth_chainId') return '0x14a34'
  if (method === 'eth_getCode') return '0x6001'
  if (method !== 'eth_call') throw new Error(`unexpected method ${method}`)
  const { data } = params[0] as { data: string }
  const fn = iface.getFunction(data.slice(0, 10))
  if (!fn) throw new Error(`unexpected selector ${data.slice(0, 10)}`)
  if (fn.name === 'authorityCount') return iface.encodeFunctionResult(fn, [Object.keys(AUTHORITIES).length])
  const [id] = iface.decodeFunctionData(fn, data)
  if (fn.name === 'getAuthority') return iface.encodeFunctionResult(fn, AUTHORITIES[Number(id)])
  return iface.encodeFunctionResult(fn, [Number(id) === 1 ? PROBATION_END : 0])
}

describe('NativeAccountProvider.listAuthorities (fake node)', () => {
  let server: Server
  let rpcUrl: string
  const probationReads: number[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const one = (r: { id: number; method: string; params: unknown[] }) => {
          try {
            if (r.method === 'eth_call') {
              const data = (r.params[0] as { data: string }).data
              if (iface.getFunction(data.slice(0, 10))?.name === 'probationEndsAt') {
                probationReads.push(Number(iface.decodeFunctionData('probationEndsAt', data)[0]))
              }
            }
            return { jsonrpc: '2.0', id: r.id, result: answer(r.method, r.params) }
          } catch (err) {
            return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: (err as Error).message } }
          }
        }
        const parsed = JSON.parse(body)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.closeAllConnections?.()
    server.close()
  })

  it('lists High, probationary High and Partner authorities, reads probation only for Highs, skips None', async () => {
    const provider = new NativeAccountProvider({
      scope: 'cofferdam',
      rpcUrl,
      chainId: 84532,
      contracts: { factory: FACTORY, passkeyModule: HIGH_MODULE },
      accountAddress: ACCOUNT,
      userId: 'list-authorities-test',
    })

    const records = await provider.listAuthorities()

    expect(records.map((r) => r.id)).toEqual([0, 1, 2])
    expect(records.map((r) => r.tier)).toEqual(['high', 'high', 'partner'])
    expect(records.map((r) => r.kind)).toEqual(['passkey', 'passkey', 'partner_passkey'])
    expect(records[2]).toMatchObject({ module: PARTNER_MODULE, isPasskey: false, active: true })

    // The genesis High is not probationary; the second High is, until the chain says so.
    expect(records.map((r) => r.probationEndsAt)).toEqual([null, PROBATION_END, null])
    // The Partner has no probation, so the getter is not even called for it.
    expect(probationReads.sort()).toEqual([0, 1])
  })
})
