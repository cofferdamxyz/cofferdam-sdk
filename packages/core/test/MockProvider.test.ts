import { describe, expect, it } from 'vitest'
import { Cofferdam, MockProvider, SignInRejected } from '../src/index.js'

describe('MockProvider.signIn', () => {
  it('returns a deterministic appPseudonym for a given (scope, mockUserId) pair', async () => {
    const a = new MockProvider({ scope: 'offshoresync', mockUserId: 'user-1', latencyMs: 0 })
    const b = new MockProvider({ scope: 'offshoresync', mockUserId: 'user-1', latencyMs: 0 })

    const r1 = await a.signIn({})
    const r2 = await b.signIn({})

    expect(r1.appPseudonym).toBe(r2.appPseudonym)
    expect(r1.appPseudonym).toMatch(/^cd_pseudo_[0-9a-f]{24}$/)
  })

  it('returns different pseudonyms for different scopes (per-app unlinkability)', async () => {
    const offshoresync = new MockProvider({ scope: 'offshoresync', mockUserId: 'user-1', latencyMs: 0 })
    const otherapp = new MockProvider({ scope: 'pnp-club', mockUserId: 'user-1', latencyMs: 0 })

    const r1 = await offshoresync.signIn({})
    const r2 = await otherapp.signIn({})

    expect(r1.appPseudonym).not.toBe(r2.appPseudonym)
  })

  it('returns a 20-byte 0x-prefixed mock account address', async () => {
    const p = new MockProvider({ scope: 'offshoresync', mockUserId: 'user-1', latencyMs: 0 })
    const r = await p.signIn({})
    expect(r.accountAddress).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('returns verifiedClaims when verified=true and null when false', async () => {
    const verified = new MockProvider({ scope: 's', mockUserId: 'u', verified: true, latencyMs: 0 })
    const unverified = new MockProvider({ scope: 's', mockUserId: 'u', verified: false, latencyMs: 0 })

    const v = await verified.signIn({})
    const u = await unverified.signIn({})

    expect(v.verified).toBe(true)
    expect(v.verifiedClaims).not.toBeNull()
    expect(v.verifiedClaims?.country).toBe('BR')

    expect(u.verified).toBe(false)
    expect(u.verifiedClaims).toBeNull()
  })

  it('honors allowedCountries policy by rejecting non-allowed countries', async () => {
    const provider = new MockProvider({
      scope: 'us-only-app',
      mockUserId: 'user-1',
      latencyMs: 0,
      verifiedClaims: { country: 'BR' },
    })
    await expect(provider.signIn({ allowedCountries: ['US'] })).rejects.toBeInstanceOf(SignInRejected)
  })

  it('honors blockedCountries policy', async () => {
    const provider = new MockProvider({
      scope: 'app',
      mockUserId: 'user-1',
      latencyMs: 0,
      verifiedClaims: { country: 'BR' },
    })
    await expect(provider.signIn({ blockedCountries: ['BR'] })).rejects.toBeInstanceOf(SignInRejected)
  })

  it('rejects unverified user when enforceSelfBeforeAccount is true', async () => {
    const provider = new MockProvider({
      scope: 'strict-app',
      mockUserId: 'user-1',
      verified: false,
      latencyMs: 0,
    })
    await expect(provider.signIn({ enforceSelfBeforeAccount: true })).rejects.toBeInstanceOf(SignInRejected)
  })

  it('permits unverified user under default policy (enforceSelfBeforeAccount = false)', async () => {
    const provider = new MockProvider({
      scope: 'permissive-app',
      mockUserId: 'user-1',
      verified: false,
      latencyMs: 0,
    })
    const r = await provider.signIn({})
    expect(r.verified).toBe(false)
    expect(r.verifiedClaims).toBeNull()
  })

  it('emits a base64url mock session token prefixed with "mock."', async () => {
    const provider = new MockProvider({ scope: 'app', mockUserId: 'user-1', latencyMs: 0 })
    const r = await provider.signIn({})
    expect(r.sessionToken).toMatch(/^mock\.[A-Za-z0-9_-]+$/)
  })
})

describe('Cofferdam class', () => {
  it('auto-constructs a MockProvider for network=mock', async () => {
    const cofferdam = new Cofferdam({
      scope: 'offshoresync',
      scopeDisplayName: 'OffshoreSync',
      network: 'mock',
    })

    const result = await cofferdam.signIn()
    expect(result.appPseudonym).toMatch(/^cd_pseudo_/)
    expect(cofferdam.getSession()?.appPseudonym).toBe(result.appPseudonym)

    cofferdam.signOut()
    expect(cofferdam.getSession()).toBeNull()
  })

  it('throws for non-mock networks until α-2/α-3 providers land', () => {
    expect(() => new Cofferdam({
      scope: 'offshoresync',
      scopeDisplayName: 'OffshoreSync',
      network: 'local',
    })).toThrow(/no built-in provider/)
  })

  it('accepts a custom provider for any network mode', async () => {
    const customProvider = new MockProvider({ scope: 'app', mockUserId: 'x', latencyMs: 0 })
    const cofferdam = new Cofferdam({
      scope: 'app',
      scopeDisplayName: 'App',
      network: 'testnet',
      provider: customProvider,
    })
    const r = await cofferdam.signIn()
    expect(r.appPseudonym).toMatch(/^cd_pseudo_/)
  })

  it('merges default policy with per-call policy', async () => {
    const cofferdam = new Cofferdam({
      scope: 'app',
      scopeDisplayName: 'App',
      network: 'mock',
      policy: { allowedCountries: ['BR'] },
    })
    await expect(cofferdam.signIn()).resolves.toBeTruthy()
    await expect(cofferdam.signIn({ policy: { allowedCountries: ['US'] } }))
      .rejects.toBeInstanceOf(SignInRejected)
  })
})
