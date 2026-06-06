import { describe, expect, it } from 'vitest'
import {
  AlreadyHighTierError,
  Cofferdam,
  DEFAULT_DEVICE_CAPABILITY,
  ManagedAuthorityNotUpgradableError,
  MockProvider,
  PasskeyUpgradeUnsupportedError,
  UpgradePathLockedError,
  assertCanEnrollFirstPasskey,
  authorityStateFromResponse,
  chooseEnrollmentLane,
  evaluateUpgrade,
  isUntrustedLowTier,
  nextMigrationStatus,
  tierOf,
} from '../src/index.js'
import type {
  AuthorityState,
  CofferdamProvider,
  DeviceCapability,
  SignInResponse,
} from '../src/index.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const APP_REACHABLE: DeviceCapability = {
  hasPlatformAuthenticator: false,
  inBrowserPasskeyReliable: false,
  nativeAppReachable: true,
}
const BROWSER_CAPABLE: DeviceCapability = {
  hasPlatformAuthenticator: true,
  inBrowserPasskeyReliable: true,
  nativeAppReachable: false,
}
const NOTHING: DeviceCapability = {
  hasPlatformAuthenticator: false,
  inBrowserPasskeyReliable: false,
  nativeAppReachable: false,
}

function mkState(partial: Partial<AuthorityState> & Pick<AuthorityState, 'active'>): AuthorityState {
  return {
    passkeyCount: 0,
    upgradeLocked: false,
    accountDeployed: false,
    migrationStatus: 'pending',
    ...partial,
  }
}

// ── tierOf / isUntrustedLowTier ──────────────────────────────────────────────

describe('tierOf', () => {
  it('maps each authority kind to its tier', () => {
    expect(tierOf('passkey')).toBe('high')
    expect(tierOf('polis_sso')).toBe('low_managed')
    expect(tierOf('password')).toBe('low_untrusted')
    expect(tierOf('oauth_google')).toBe('low_untrusted')
    expect(tierOf('oauth_apple')).toBe('low_untrusted')
  })
})

describe('isUntrustedLowTier', () => {
  it('is true only for leakable consumer credentials', () => {
    expect(isUntrustedLowTier('password')).toBe(true)
    expect(isUntrustedLowTier('oauth_google')).toBe(true)
    expect(isUntrustedLowTier('oauth_apple')).toBe(true)
    expect(isUntrustedLowTier('passkey')).toBe(false)
    expect(isUntrustedLowTier('polis_sso')).toBe(false)
  })
})

// ── chooseEnrollmentLane ─────────────────────────────────────────────────────

describe('chooseEnrollmentLane', () => {
  it('prefers the QR handoff whenever the RN app is reachable', () => {
    expect(chooseEnrollmentLane(APP_REACHABLE)).toBe('qr_handoff')
    // even if in-browser is also possible + opted in, the app wins.
    expect(
      chooseEnrollmentLane(
        { ...BROWSER_CAPABLE, nativeAppReachable: true },
        { allowInBrowserPasskey: true },
      ),
    ).toBe('qr_handoff')
  })

  it('uses in-browser only when opted in, capable, and the app is unreachable', () => {
    expect(chooseEnrollmentLane(BROWSER_CAPABLE, { allowInBrowserPasskey: true })).toBe('in_browser')
  })

  it('returns null when in-browser is not opted in', () => {
    expect(chooseEnrollmentLane(BROWSER_CAPABLE)).toBeNull()
    expect(chooseEnrollmentLane(BROWSER_CAPABLE, { allowInBrowserPasskey: false })).toBeNull()
  })

  it('returns null when opted in but the device is not browser-capable', () => {
    expect(
      chooseEnrollmentLane(
        { ...BROWSER_CAPABLE, inBrowserPasskeyReliable: false },
        { allowInBrowserPasskey: true },
      ),
    ).toBeNull()
  })

  it('returns null for the conservative default capability', () => {
    expect(chooseEnrollmentLane(DEFAULT_DEVICE_CAPABILITY)).toBeNull()
    expect(chooseEnrollmentLane(NOTHING, { allowInBrowserPasskey: true })).toBeNull()
  })
})

// ── evaluateUpgrade ──────────────────────────────────────────────────────────

describe('evaluateUpgrade', () => {
  it('requires the first passkey for an untrusted low-tier session with no passkey', () => {
    const d = evaluateUpgrade(
      mkState({ active: { kind: 'password', tier: 'low_untrusted' } }),
      APP_REACHABLE,
    )
    expect(d).not.toBeNull()
    expect(d?.required).toBe(true)
    expect(d?.recommended).toBe(true)
    expect(d?.lane).toBe('qr_handoff')
    expect(d?.reason).toBe('untrusted_low_tier_no_passkey')
  })

  it('flags install_app_required when no enrolment lane is viable', () => {
    const d = evaluateUpgrade(
      mkState({ active: { kind: 'oauth_google', tier: 'low_untrusted' } }),
      NOTHING,
    )
    expect(d?.required).toBe(true)
    expect(d?.reason).toBe('install_app_required')
  })

  it('returns null once the ratchet has fired (a passkey already exists)', () => {
    expect(
      evaluateUpgrade(
        mkState({
          active: { kind: 'password', tier: 'low_untrusted' },
          passkeyCount: 1,
          upgradeLocked: true,
        }),
        APP_REACHABLE,
      ),
    ).toBeNull()
  })

  it('never drives the consumer ratchet for a managed Polis-SSO authority', () => {
    expect(
      evaluateUpgrade(mkState({ active: { kind: 'polis_sso', tier: 'low_managed' } }), APP_REACHABLE),
    ).toBeNull()
  })

  it('recommends (not requires) a backup for a single-passkey high-tier user', () => {
    const d = evaluateUpgrade(
      mkState({
        active: { kind: 'passkey', tier: 'high' },
        passkeyCount: 1,
        upgradeLocked: true,
        accountDeployed: true,
        migrationStatus: 'enrolled',
      }),
      APP_REACHABLE,
    )
    expect(d?.required).toBe(false)
    expect(d?.recommended).toBe(true)
    expect(d?.reason).toBe('add_backup_device')
  })

  it('returns null for a high-tier user that already has a backup', () => {
    expect(
      evaluateUpgrade(
        mkState({
          active: { kind: 'passkey', tier: 'high' },
          passkeyCount: 2,
          upgradeLocked: true,
          accountDeployed: true,
          migrationStatus: 'enrolled',
        }),
        APP_REACHABLE,
      ),
    ).toBeNull()
  })
})

// ── assertCanEnrollFirstPasskey (ratchet guards) ─────────────────────────────

describe('assertCanEnrollFirstPasskey', () => {
  it('permits enrolment for an untrusted low-tier authority with no passkey', () => {
    expect(() =>
      assertCanEnrollFirstPasskey(mkState({ active: { kind: 'password', tier: 'low_untrusted' } })),
    ).not.toThrow()
  })

  it('rejects when the active authority is already a passkey', () => {
    expect(() =>
      assertCanEnrollFirstPasskey(
        mkState({ active: { kind: 'passkey', tier: 'high' }, passkeyCount: 1, upgradeLocked: true }),
      ),
    ).toThrow(AlreadyHighTierError)
  })

  it('rejects a managed Polis-SSO authority', () => {
    expect(() =>
      assertCanEnrollFirstPasskey(mkState({ active: { kind: 'polis_sso', tier: 'low_managed' } })),
    ).toThrow(ManagedAuthorityNotUpgradableError)
  })

  it('rejects once the ratchet has fired (passkey exists but a low-tier cred is presented)', () => {
    expect(() =>
      assertCanEnrollFirstPasskey(
        mkState({ active: { kind: 'password', tier: 'low_untrusted' }, passkeyCount: 1, upgradeLocked: true }),
      ),
    ).toThrow(UpgradePathLockedError)
  })
})

// ── nextMigrationStatus ──────────────────────────────────────────────────────

describe('nextMigrationStatus', () => {
  it('advances pending → enrolled / declined', () => {
    expect(nextMigrationStatus('pending', 'passkey_enrolled')).toBe('enrolled')
    expect(nextMigrationStatus('pending', 'declined')).toBe('declined')
  })

  it('allows declined → enrolled (decline is not terminal)', () => {
    expect(nextMigrationStatus('declined', 'passkey_enrolled')).toBe('enrolled')
    expect(nextMigrationStatus('declined', 'reset')).toBe('pending')
  })

  it('treats enrolled as terminal', () => {
    expect(nextMigrationStatus('enrolled', 'declined')).toBe('enrolled')
    expect(nextMigrationStatus('enrolled', 'reset')).toBe('enrolled')
    expect(nextMigrationStatus('enrolled', 'passkey_enrolled')).toBe('enrolled')
  })
})

// ── authorityStateFromResponse ───────────────────────────────────────────────

describe('authorityStateFromResponse', () => {
  const base: SignInResponse = {
    appPseudonym: 'cd_pseudo_x',
    accountAddress: `0x${'0'.repeat(40)}`,
    verified: true,
    verifiedClaims: null,
    scopeKey: 'k',
    sessionToken: 't',
    attestation: 'a',
  }

  it('infers a deployed, locked, enrolled state for a high-tier response', () => {
    const s = authorityStateFromResponse({ ...base, authority: { kind: 'passkey', tier: 'high' } })
    expect(s.passkeyCount).toBe(1)
    expect(s.upgradeLocked).toBe(true)
    expect(s.accountDeployed).toBe(true)
    expect(s.migrationStatus).toBe('enrolled')
  })

  it('infers a counterfactual, pending state for a low-tier response', () => {
    const s = authorityStateFromResponse({ ...base, authority: { kind: 'password', tier: 'low_untrusted' } })
    expect(s.passkeyCount).toBe(0)
    expect(s.upgradeLocked).toBe(false)
    expect(s.accountDeployed).toBe(false)
    expect(s.migrationStatus).toBe('pending')
  })
})

// ── End-to-end via Cofferdam + MockProvider ──────────────────────────────────

function cofferdamWith(provider: CofferdamProvider, policy = {}): Cofferdam {
  return new Cofferdam({ scope: 'app', scopeDisplayName: 'App', network: 'mock', provider, policy })
}

describe('Cofferdam password→passkey migration (mock)', () => {
  it('surfaces a required upgrade for a counterfactual low-tier login', async () => {
    const provider = new MockProvider({ scope: 'app', mockUserId: 'u', authorityKind: 'password', latencyMs: 0 })
    const cd = cofferdamWith(provider)

    const r = await cd.signIn()
    expect(r.authority?.tier).toBe('low_untrusted')
    expect(r.accountDeployed).toBe(false)
    expect(r.migrationStatus).toBe('pending')
    expect(r.upgrade?.required).toBe(true)
    expect(r.upgrade?.reason).toBe('untrusted_low_tier_no_passkey')
    expect(r.upgrade?.lane).toBe('qr_handoff')
  })

  it('enrols the first passkey, fires the ratchet, and keeps the same AA address', async () => {
    const provider = new MockProvider({ scope: 'app', mockUserId: 'u', authorityKind: 'password', latencyMs: 0 })
    const cd = cofferdamWith(provider)

    const signedIn = await cd.signIn()
    const result = await cd.upgradeToPasskey()

    expect(result.accountDeployed).toBe(true)
    expect(result.migrationStatus).toBe('enrolled')
    expect(result.upgradeLocked).toBe(true)
    expect(result.authority.tier).toBe('high')
    expect(result.accountAddress).toBe(signedIn.accountAddress)
    expect(result.passkeyCredentialId).toContain('qr_handoff')

    const session = cd.getSession()
    expect(session?.authority?.tier).toBe('high')
    expect(session?.accountDeployed).toBe(true)
    expect(session?.migrationStatus).toBe('enrolled')
    expect(session?.upgrade).toBeNull()
  })

  it('takes the in-browser lane when opted in and the app is unreachable', async () => {
    const provider = new MockProvider({
      scope: 'app',
      mockUserId: 'u',
      authorityKind: 'oauth_google',
      deviceCapability: BROWSER_CAPABLE,
      latencyMs: 0,
    })
    const cd = cofferdamWith(provider, { allowInBrowserPasskey: true })

    const r = await cd.signIn()
    expect(r.upgrade?.lane).toBe('in_browser')

    const result = await cd.upgradeToPasskey()
    expect(result.passkeyCredentialId).toContain('in_browser')
  })

  it('cannot upgrade twice — the ratchet locks the low-tier authority out', async () => {
    // A passkey already exists but the user still presents the password cred.
    const provider = new MockProvider({
      scope: 'app',
      mockUserId: 'u',
      authorityKind: 'password',
      passkeyCount: 1,
      latencyMs: 0,
    })
    const cd = cofferdamWith(provider)
    await cd.signIn()
    await expect(cd.upgradeToPasskey()).rejects.toBeInstanceOf(UpgradePathLockedError)
  })

  it('rejects upgrading an already high-tier passkey session', async () => {
    const provider = new MockProvider({ scope: 'app', mockUserId: 'u', authorityKind: 'passkey', latencyMs: 0 })
    const cd = cofferdamWith(provider)

    const r = await cd.signIn()
    expect(r.upgrade?.reason).toBe('add_backup_device')
    expect(r.upgrade?.required).toBe(false)
    await expect(cd.upgradeToPasskey()).rejects.toBeInstanceOf(AlreadyHighTierError)
  })

  it('rejects the consumer ratchet for a managed Polis-SSO session', async () => {
    const provider = new MockProvider({ scope: 'app', mockUserId: 'u', authorityKind: 'polis_sso', latencyMs: 0 })
    const cd = cofferdamWith(provider)

    const r = await cd.signIn()
    expect(r.upgrade).toBeNull()
    await expect(cd.upgradeToPasskey()).rejects.toBeInstanceOf(ManagedAuthorityNotUpgradableError)
  })

  it('declines the upgrade, then still allows a later enrolment', async () => {
    const provider = new MockProvider({ scope: 'app', mockUserId: 'u', authorityKind: 'password', latencyMs: 0 })
    const cd = cofferdamWith(provider)
    await cd.signIn()

    await cd.declinePasskeyUpgrade()
    expect(cd.getSession()?.migrationStatus).toBe('declined')
    expect(cd.getSession()?.upgrade).toBeNull()

    const result = await cd.upgradeToPasskey()
    expect(result.migrationStatus).toBe('enrolled')
    expect(cd.getSession()?.authority?.tier).toBe('high')
  })

  it('errors when no enrolment lane is viable on this device', async () => {
    const provider = new MockProvider({
      scope: 'app',
      mockUserId: 'u',
      authorityKind: 'password',
      deviceCapability: NOTHING,
      latencyMs: 0,
    })
    const cd = cofferdamWith(provider)

    const r = await cd.signIn()
    expect(r.upgrade?.reason).toBe('install_app_required')
    await expect(cd.upgradeToPasskey()).rejects.toBeInstanceOf(PasskeyUpgradeUnsupportedError)
  })

  it('errors when upgradeToPasskey is called before signIn', async () => {
    const provider = new MockProvider({ scope: 'app', mockUserId: 'u', authorityKind: 'password', latencyMs: 0 })
    const cd = cofferdamWith(provider)
    await expect(cd.upgradeToPasskey()).rejects.toThrow(/call signIn/)
  })

  it('errors when the provider does not implement passkey enrolment', async () => {
    const legacy: CofferdamProvider = {
      mode: 'mock',
      async signIn(): Promise<SignInResponse> {
        return {
          appPseudonym: 'cd_pseudo_legacy',
          accountAddress: `0x${'1'.repeat(40)}`,
          verified: true,
          verifiedClaims: null,
          scopeKey: 'k',
          sessionToken: 't',
          attestation: 'a',
        }
      },
    }
    const cd = cofferdamWith(legacy)
    const r = await cd.signIn()
    // A provider that predates the tiered model omits `authority`/`upgrade`.
    expect(r.authority).toBeUndefined()
    expect(r.upgrade).toBeUndefined()
    await expect(cd.upgradeToPasskey()).rejects.toBeInstanceOf(PasskeyUpgradeUnsupportedError)
  })
})
