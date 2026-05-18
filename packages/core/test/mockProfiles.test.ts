import { describe, expect, it } from 'vitest'
import {
  MockProvider,
  getMockProfile,
  mockProfiles,
  type MockProfileName,
} from '../src/index.js'

const ALL_PROFILE_NAMES: MockProfileName[] = [
  'verified-br',
  'verified-us',
  'unverified',
  'ofac-flagged',
  'stale-proof',
]

describe('mockProfiles registry', () => {
  it('exports all five documented profiles', () => {
    expect(Object.keys(mockProfiles).sort()).toEqual([...ALL_PROFILE_NAMES].sort())
  })

  it.each(ALL_PROFILE_NAMES)(
    "profile '%s' has a stable mockUserId",
    (name) => {
      const profile = mockProfiles[name]
      expect(profile.mockUserId).toBeDefined()
      expect(typeof profile.mockUserId).toBe('string')
      expect(profile.mockUserId).not.toBe('')
    },
  )

  it("'verified-br' is verified and matches the documented BR / 18+ / OFAC-clear shape", () => {
    const p = mockProfiles['verified-br']
    expect(p.verified).toBe(true)
    expect(p.verifiedClaims).toMatchObject({
      country: 'BR',
      olderThan: 18,
      ofacClear: true,
    })
  })

  it("'verified-us' is verified and US-shaped (21+, OFAC-clear)", () => {
    const p = mockProfiles['verified-us']
    expect(p.verified).toBe(true)
    expect(p.verifiedClaims).toMatchObject({
      country: 'US',
      olderThan: 21,
      ofacClear: true,
    })
  })

  it("'unverified' has verified=false and no verifiedClaims override", () => {
    const p = mockProfiles.unverified
    expect(p.verified).toBe(false)
    // The MockProvider falls back to its own default verifiedClaims if the
    // profile does not supply them; verifying that here would couple the
    // test to MockProvider internals. Instead just confirm the profile
    // does not lie about being verified.
    expect(p.verifiedClaims).toBeUndefined()
  })

  it("'ofac-flagged' is verified BUT ofacClear=false", () => {
    const p = mockProfiles['ofac-flagged']
    expect(p.verified).toBe(true)
    expect(p.verifiedClaims?.ofacClear).toBe(false)
  })

  it("'stale-proof' has a proofTimestamp older than 90 days", () => {
    const p = mockProfiles['stale-proof']
    const ninetyDaysAgo = Date.now() - 90 * 86_400_000
    expect(p.verifiedClaims?.proofTimestamp).toBeLessThan(ninetyDaysAgo)
  })
})

describe('getMockProfile', () => {
  it('returns the profile for a known name', () => {
    expect(getMockProfile('verified-br')).toBe(mockProfiles['verified-br'])
  })

  it('throws a helpful error for an unknown name', () => {
    expect(() => getMockProfile('does-not-exist')).toThrow(
      /unknown mock profile: 'does-not-exist'/,
    )
    expect(() => getMockProfile('does-not-exist')).toThrow(
      /Available: verified-br, verified-us, unverified, ofac-flagged, stale-proof/,
    )
  })

  it('rejects a prototype-pollution lookup attempt', () => {
    expect(() => getMockProfile('__proto__')).toThrow(/unknown mock profile/)
    expect(() => getMockProfile('constructor')).toThrow(/unknown mock profile/)
  })
})

describe('mockProfiles ↔ MockProvider integration', () => {
  it.each(ALL_PROFILE_NAMES)(
    "profile '%s' produces a deterministic appPseudonym across instances",
    async (name) => {
      const a = new MockProvider({ scope: 'offshoresync', latencyMs: 0, ...mockProfiles[name] })
      const b = new MockProvider({ scope: 'offshoresync', latencyMs: 0, ...mockProfiles[name] })

      const r1 = await a.signIn({})
      const r2 = await b.signIn({})

      expect(r1.appPseudonym).toBe(r2.appPseudonym)
      expect(r1.accountAddress).toBe(r2.accountAddress)
    },
  )

  it('different profiles produce different appPseudonyms', async () => {
    const seen = new Set<string>()
    for (const name of ALL_PROFILE_NAMES) {
      const provider = new MockProvider({
        scope: 'offshoresync',
        latencyMs: 0,
        ...mockProfiles[name],
      })
      const r = await provider.signIn({})
      seen.add(r.appPseudonym)
    }
    expect(seen.size).toBe(ALL_PROFILE_NAMES.length)
  })

  it("'unverified' profile yields verified=false and verifiedClaims=null on signIn", async () => {
    const provider = new MockProvider({
      scope: 'offshoresync',
      latencyMs: 0,
      ...mockProfiles.unverified,
    })
    const r = await provider.signIn({})
    expect(r.verified).toBe(false)
    expect(r.verifiedClaims).toBeNull()
  })

  it("'ofac-flagged' profile yields verified=true with ofacClear=false on signIn", async () => {
    const provider = new MockProvider({
      scope: 'offshoresync',
      latencyMs: 0,
      ...mockProfiles['ofac-flagged'],
    })
    const r = await provider.signIn({})
    expect(r.verified).toBe(true)
    expect(r.verifiedClaims?.ofacClear).toBe(false)
  })
})
