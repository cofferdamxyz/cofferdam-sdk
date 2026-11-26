/**
 * A Partner or Managed authority's grant (`IAuthorityModule.Permission`,
 * decision 0016): the calls it may make through `execute` / `executeBatch`.
 * High authorities carry none. The genesis permission is part of the
 * account's CREATE2 address, so it must be byte-identical on every call.
 */
export interface Permission {
    targets: string[];
    /** `bytes4` selectors, one per target. */
    selectors: string[];
    /** Runtime code hashes reachable by `codeSelectors` (per-job contracts). */
    codeHashes: string[];
    codeSelectors: string[];
    valueCap: bigint;
    /** Unix seconds (`uint48`); 0 = never expires (High only). */
    expiry: number;
}
/** The empty permission a High (passkey) genesis or backup passkey carries. */
export declare const NO_PERMISSION: Permission;
/** The tuple as the factory and account ABIs spell it. */
export declare const PERMISSION_TUPLE = "(address[] targets, bytes4[] selectors, bytes32[] codeHashes, bytes4[] codeSelectors, uint256 valueCap, uint48 expiry)";
//# sourceMappingURL=permission.d.ts.map