/** The empty permission a High (passkey) genesis or backup passkey carries. */
export const NO_PERMISSION = {
    targets: [],
    selectors: [],
    codeHashes: [],
    codeSelectors: [],
    valueCap: 0n,
    expiry: 0,
};
/** The tuple as the factory and account ABIs spell it. */
export const PERMISSION_TUPLE = '(address[] targets, bytes4[] selectors, bytes32[] codeHashes, bytes4[] codeSelectors, uint256 valueCap, uint48 expiry)';
//# sourceMappingURL=permission.js.map