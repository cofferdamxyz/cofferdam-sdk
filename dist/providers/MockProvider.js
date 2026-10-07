// In-process mock provider — Phase α-1.
//
// Stands in for the (not-yet-existing) Cofferdam mobile app. Returns
// deterministic-but-realistic SignInResponse values so the consumer-app
// integration (OffshoreSync react-client) can be developed and tested
// before any chain, any deep-link, and any real Cofferdam app exist.
//
// Replaced by:
//   - LocalChainProvider   in α-2 (real chain, no real mobile app)
//   - TestnetProvider      in α-3 (real testnet + real Cofferdam mobile shell)
//   - ProductionProvider   in β  (mainnet + real Cofferdam app)
//
// Selecting via `new Cofferdam({ network: 'mock', ... })`.
import { assertCanEnrollFirstPasskey, tierOf } from '../identity/authority.js';
import { derivePseudonym, deriveScopeKey } from '../identity/pseudonym.js';
// This module is the `@cofferdam/sdk/mock` entry point per the package's
// `exports` map. We re-export the named-fixture registry (`mockProfiles`,
// `getMockProfile`) so consumer apps can pick a profile without a separate
// `@cofferdam/sdk/mock-profiles` import path.
export { mockProfiles, getMockProfile } from './mockProfiles.js';
export class SignInRejected extends Error {
    code;
    constructor(code, message) {
        super(message ?? `[cofferdam-sdk] sign-in rejected: ${code}`);
        this.name = 'SignInRejected';
        this.code = code;
    }
}
export class MockProvider {
    mode = 'mock';
    config;
    capability;
    state;
    constructor(config) {
        this.config = {
            scope: config.scope,
            scopeSalt: config.scopeSalt ?? `mock-salt:${config.scope}`,
            mockUserId: config.mockUserId ?? 'mock-user-default',
            verified: config.verified ?? true,
            verifiedClaims: {
                country: 'BR',
                olderThan: 18,
                ofacClear: true,
                proofTimestamp: Date.now(),
                ...config.verifiedClaims,
            },
            latencyMs: config.latencyMs ?? 250,
        };
        // ── Tiered-authority state (rev-7.7) ──────────────────────────────────────
        const kind = config.authorityKind ?? 'passkey';
        const tier = tierOf(kind);
        const passkeyCount = config.passkeyCount ?? (tier === 'high' ? 1 : 0);
        this.state = {
            active: { kind, tier },
            passkeyCount,
            upgradeLocked: passkeyCount > 0,
            accountDeployed: config.accountDeployed ?? tier === 'high',
            migrationStatus: config.migrationStatus ?? (tier === 'high' ? 'enrolled' : 'pending'),
        };
        this.capability = {
            hasPlatformAuthenticator: config.deviceCapability?.hasPlatformAuthenticator ?? false,
            inBrowserPasskeyReliable: config.deviceCapability?.inBrowserPasskeyReliable ?? false,
            // Mock default: the RN app is reachable, so the canonical QR lane works
            // out of the box for migration tests.
            nativeAppReachable: config.deviceCapability?.nativeAppReachable ?? true,
        };
    }
    async signIn(policy) {
        await sleep(this.config.latencyMs);
        // Country gating (policy enforcement on the mock side; production
        // enforcement is defense-in-depth across SDK + Cofferdam backend +
        // optionally on-chain).
        const country = this.config.verifiedClaims.country;
        if (policy.allowedCountries &&
            country &&
            !policy.allowedCountries.includes(country)) {
            throw new SignInRejected('country_blocked', `[cofferdam-sdk] mock user country '${country}' not in allowedCountries: ${policy.allowedCountries.join(',')}`);
        }
        if (policy.blockedCountries &&
            country &&
            policy.blockedCountries.includes(country)) {
            throw new SignInRejected('country_blocked', `[cofferdam-sdk] mock user country '${country}' is in blockedCountries`);
        }
        // Strict-mode policy: if the consumer app requires Self-before-account
        // and the mock user isn't verified, fail. Default policy (false) lets
        // unverified users sign in (Self is value-gated; see README §2.4).
        if (policy.enforceSelfBeforeAccount && !this.config.verified) {
            throw new SignInRejected('self_verification_failed', '[cofferdam-sdk] mock user is unverified and policy requires Self before account');
        }
        const nullifier = `mock-nullifier:${this.config.mockUserId}`;
        const appPseudonym = await derivePseudonym(this.config.scopeSalt, nullifier);
        const accountAddress = await deriveMockAddress(this.config.mockUserId);
        const scopeKey = await deriveScopeKey(nullifier, this.config.scope);
        return {
            appPseudonym,
            accountAddress,
            verified: this.config.verified,
            verifiedClaims: this.config.verified ? this.config.verifiedClaims : null,
            scopeKey,
            sessionToken: encodeMockSessionToken({
                scope: this.config.scope,
                appPseudonym,
                issuedAt: Date.now(),
            }),
            attestation: 'mock-attestation-v1',
            authority: { ...this.state.active },
            migrationStatus: this.state.migrationStatus,
            accountDeployed: this.state.accountDeployed,
        };
    }
    signOut() {
        // No persistent state to clear in this provider.
    }
    async getAuthorityState() {
        // In-memory read — no simulated latency (it would compound with signIn's
        // when the Cofferdam class computes the upgrade directive).
        return { ...this.state, active: { ...this.state.active } };
    }
    deviceCapability() {
        return { ...this.capability };
    }
    async enrollFirstPasskey(opts) {
        await sleep(this.config.latencyMs);
        // Client-side ratchet guard; the on-chain validator is the real enforcer.
        assertCanEnrollFirstPasskey(this.state);
        const accountAddress = await deriveMockAddress(this.config.mockUserId);
        // Fire the one-way ratchet: the first passkey becomes the high-tier
        // authority and the untrusted low-tier authority is permanently locked out
        // (IDENTITY_LAYER_DESIGN.md §2.5.2).
        this.state = {
            active: { kind: 'passkey', tier: 'high' },
            passkeyCount: 1,
            upgradeLocked: true,
            accountDeployed: true,
            migrationStatus: 'enrolled',
        };
        return {
            accountAddress,
            accountDeployed: true,
            passkeyCredentialId: `mock-cred:${this.config.mockUserId}:${opts.lane}`,
            authority: { kind: 'passkey', tier: 'high' },
            migrationStatus: 'enrolled',
            upgradeLocked: true,
        };
    }
    async declineMigration() {
        if (this.state.migrationStatus !== 'enrolled') {
            this.state = { ...this.state, migrationStatus: 'declined' };
        }
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Deterministic 20-byte "address" derived from the mock user identifier.
 * NEVER on-chain; purely a visual stand-in so dashboards / dev UIs show
 * something address-shaped during α-1.
 */
async function deriveMockAddress(mockUserId) {
    const input = `mock-account|${mockUserId}|cofferdam-mock-account-v1`;
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('[cofferdam-sdk] SubtleCrypto unavailable');
    }
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(input)));
    // Use the last 20 bytes (Ethereum-address-shaped).
    let hex = '';
    for (let i = digest.length - 20; i < digest.length; i++) {
        hex += digest[i].toString(16).padStart(2, '0');
    }
    return `0x${hex}`;
}
/**
 * Mock session-token encoder. Base64url of JSON. NOT signed, NOT verified.
 * Production tokens are passkey-signed envelopes (β phase).
 */
function encodeMockSessionToken(payload) {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary);
    return `mock.${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
//# sourceMappingURL=MockProvider.js.map