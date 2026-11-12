/**
 * Derive a per-app pseudonym for a user.
 *
 * @param scopeSalt - Per-consumer-app constant assigned by Cofferdam at
 *                   integration-onboarding time. In α-1 mock mode, this is
 *                   derived locally from the scope string; in production the
 *                   real scopeSalt is provisioned by the Cofferdam backend.
 * @param nullifier - The user's Cofferdam nullifier. Never leaves the user's
 *                   device.
 * @returns `cd_pseudo_<24-hex>` — 12 bytes / 96 bits of pseudonym, sufficient
 *          for global uniqueness across the realistic user count of any one
 *          consumer app.
 */
export declare function derivePseudonym(scopeSalt: string, nullifier: string): Promise<string>;
/**
 * Derive the per-consumer-app encryption sub-key. See README §5.2.
 *
 * @param masterSeed - The user's Cofferdam master seed (in α-1 mock mode,
 *                    derived from the mock user identifier; in production,
 *                    derived from the smart-account root key).
 * @param scope - The consumer app's registered scope identifier.
 * @returns `cdsk_<64-hex>` — 32 bytes / 256 bits of sub-key material.
 */
export declare function deriveScopeKey(masterSeed: string, scope: string): Promise<string>;
//# sourceMappingURL=pseudonym.d.ts.map