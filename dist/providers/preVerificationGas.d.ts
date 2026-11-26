import type { PackedUserOperation } from './userOpRelay.js';
/** Base's (OP Stack) GasPriceOracle predeploy. */
export declare const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
/** The L1 fee the op pays for, in basis points: the plane's 125% plus 10% for the L1 base fee moving before the bundle lands. */
export declare const L1_FEE_MARGIN_BPS = 13750n;
/**
 * Bytes of the stand-in inner signature: an `abi.encode(WebAuthnAuth)` assertion
 * measured 480 bytes with the SDK's software authenticator (a platform's
 * `clientDataJSON` can be longer); a raw P-256 or session signature is 64 or 65.
 */
export declare const STAND_IN_INNER_SIGNATURE_BYTES = 768;
/** Intrinsic gas of a transaction carrying `data`: 21,000 plus 4 per zero byte and 16 per other byte. */
export declare function calldataGas(data: string): bigint;
/** `l2Gas + ceil(l1Fee × margin / maxFeePerGas)`. */
export declare function preVerificationGasForL1Fee(l1Fee: bigint, maxFeePerGas: bigint, l2Gas: bigint, marginBps?: bigint): bigint;
/**
 * A stand-in for `solidityPacked(uint256 authorityId, bytes inner)` with an
 * inner signature of `innerBytes` incompressible bytes, so the oracle's
 * compressed-size estimate does not undercount it.
 */
export declare function standInSignature(authorityId: number, innerBytes?: number): string;
export interface EstimateL1PreVerificationGasOptions {
    /** Runner on the op's chain (an OP Stack chain: Base, Base Sepolia, or a fork of either). */
    runner: {
        call(tx: {
            to: string;
            data: string;
        }): Promise<string>;
    };
    chainId: number | bigint;
    entryPoint: string;
    /** The op as it will be signed, with a stand-in signature (`standInSignature`). */
    userOp: PackedUserOperation;
    /**
     * The op's `maxFeePerGas`. The plane divides by the op's effective price,
     * `min(maxFeePerGas, maxPriorityFeePerGas + baseFee)`; the provider sets the
     * tip equal to `maxFeePerGas`, so the two are the same.
     */
    maxFeePerGas: bigint;
}
/**
 * Estimate `preVerificationGas` for an op the relayer bundles alone: the
 * oracle's L1 fee of the unsigned `handleOps` transaction, with the margin, in
 * gas at `maxFeePerGas`, plus the transaction's calldata gas.
 */
export declare function estimateL1PreVerificationGas(opts: EstimateL1PreVerificationGasOptions): Promise<bigint>;
//# sourceMappingURL=preVerificationGas.d.ts.map