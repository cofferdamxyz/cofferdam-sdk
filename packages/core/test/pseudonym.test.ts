import { describe, expect, it } from 'vitest'
import { derivePseudonym, deriveScopeKey } from '../src/identity/pseudonym.js'

describe('derivePseudonym', () => {
  it('is deterministic for the same (scopeSalt, nullifier) pair', async () => {
    const a = await derivePseudonym('mock-salt:offshoresync', 'mock-nullifier:user-1')
    const b = await derivePseudonym('mock-salt:offshoresync', 'mock-nullifier:user-1')
    expect(a).toBe(b)
  })

  it('emits the canonical cd_pseudo_<24-hex> wire format', async () => {
    const p = await derivePseudonym('salt', 'nullifier')
    expect(p).toMatch(/^cd_pseudo_[0-9a-f]{24}$/)
  })

  it('differs across scopes (cross-app unlinkability invariant — README §5.6)', async () => {
    const a = await derivePseudonym('mock-salt:offshoresync', 'mock-nullifier:user-1')
    const b = await derivePseudonym('mock-salt:pnp-club', 'mock-nullifier:user-1')
    expect(a).not.toBe(b)
  })

  it('differs across users within the same scope', async () => {
    const a = await derivePseudonym('mock-salt:offshoresync', 'mock-nullifier:user-1')
    const b = await derivePseudonym('mock-salt:offshoresync', 'mock-nullifier:user-2')
    expect(a).not.toBe(b)
  })
})

describe('deriveScopeKey', () => {
  it('is deterministic for the same (masterSeed, scope) pair', async () => {
    const a = await deriveScopeKey('master-seed-x', 'offshoresync')
    const b = await deriveScopeKey('master-seed-x', 'offshoresync')
    expect(a).toBe(b)
  })

  it('emits the canonical cdsk_<64-hex> format (32-byte sub-key)', async () => {
    const k = await deriveScopeKey('master-seed-x', 'offshoresync')
    expect(k).toMatch(/^cdsk_[0-9a-f]{64}$/)
  })

  it('differs across scopes for the same master seed (per-app key scoping — README §5.2)', async () => {
    const a = await deriveScopeKey('master-seed-x', 'offshoresync')
    const b = await deriveScopeKey('master-seed-x', 'pnp-club')
    expect(a).not.toBe(b)
  })

  it('differs across master seeds for the same scope', async () => {
    const a = await deriveScopeKey('master-seed-x', 'offshoresync')
    const b = await deriveScopeKey('master-seed-y', 'offshoresync')
    expect(a).not.toBe(b)
  })
})
