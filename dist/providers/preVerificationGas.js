// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * `preVerificationGas` that pays Base's L1 data fee (workspace `plane.md`,
 * Relay, the mainnet test relay of decision 0080 M2).
 *
 * On Base the L1 data fee of the bundle is charged to the relayer's
 * transaction, outside the gas the EntryPoint meters. An unsponsored op repays
 * it through `preVerificationGas × maxFeePerGas`, which the plane requires to
 * cover the GasPriceOracle's `getL1Fee` of the unsigned `handleOps`
 * transaction plus 25% (`400 pre_verification_gas_too_low` otherwise). The
 * value is signed into the op, so the client estimates it before signing:
 * from the same oracle, over the same transaction with a stand-in signature
 * of at least the real one's length, with its own margin on top of the
 * plane's, plus the transaction's L2 calldata gas, which the EntryPoint does
 * not meter either.
 */
import { Interface, Transaction, keccak256, solidityPacked } from 'ethers';
/** Base's (OP Stack) GasPriceOracle predeploy. */
export const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
/** The L1 fee the op pays for, in basis points: the plane's 125% plus 10% for the L1 base fee moving before the bundle lands. */
export const L1_FEE_MARGIN_BPS = 13750n;
/**
 * Bytes of the stand-in inner signature: an `abi.encode(WebAuthnAuth)` assertion
 * measured 480 bytes with the SDK's software authenticator (a platform's
 * `clientDataJSON` can be longer); a raw P-256 or session signature is 64 or 65.
 */
export const STAND_IN_INNER_SIGNATURE_BYTES = 768;
const ORACLE_IFACE = new Interface(['function getL1Fee(bytes data) view returns (uint256)']);
const HANDLE_OPS_IFACE = new Interface([
    'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary)',
]);
/** Intrinsic gas of a transaction carrying `data`: 21,000 plus 4 per zero byte and 16 per other byte. */
export function calldataGas(data) {
    const hex = data.startsWith('0x') ? data.slice(2) : data;
    let gas = 21000n;
    for (let i = 0; i < hex.length; i += 2)
        gas += hex.slice(i, i + 2) === '00' ? 4n : 16n;
    return gas;
}
/** `l2Gas + ceil(l1Fee × margin / maxFeePerGas)`. */
export function preVerificationGasForL1Fee(l1Fee, maxFeePerGas, l2Gas, marginBps = L1_FEE_MARGIN_BPS) {
    if (maxFeePerGas <= 0n)
        throw new Error('[cofferdam-sdk] preVerificationGas: maxFeePerGas must be positive');
    const covered = l1Fee * marginBps;
    const denominator = maxFeePerGas * 10000n;
    return l2Gas + (covered + denominator - 1n) / denominator;
}
/**
 * A stand-in for `solidityPacked(uint256 authorityId, bytes inner)` with an
 * inner signature of `innerBytes` incompressible bytes, so the oracle's
 * compressed-size estimate does not undercount it.
 */
export function standInSignature(authorityId, innerBytes = STAND_IN_INNER_SIGNATURE_BYTES) {
    let filler = '';
    let block = keccak256('0x' + authorityId.toString(16).padStart(64, '0'));
    while (filler.length < innerBytes * 2) {
        filler += block.slice(2);
        block = keccak256(block);
    }
    return solidityPacked(['uint256', 'bytes'], [authorityId, '0x' + filler.slice(0, innerBytes * 2)]);
}
/**
 * Estimate `preVerificationGas` for an op the relayer bundles alone: the
 * oracle's L1 fee of the unsigned `handleOps` transaction, with the margin, in
 * gas at `maxFeePerGas`, plus the transaction's calldata gas.
 */
export async function estimateL1PreVerificationGas(opts) {
    // The relayer's address is unknown here; the sender stands in (20 non-zero bytes, as the relayer's).
    const data = HANDLE_OPS_IFACE.encodeFunctionData('handleOps', [[opTuple(opts.userOp)], opts.userOp.sender]);
    const unsigned = Transaction.from({
        type: 2,
        chainId: BigInt(opts.chainId),
        nonce: 0xffff,
        to: opts.entryPoint,
        data,
        gasLimit: 30000000n,
        maxFeePerGas: opts.maxFeePerGas,
        maxPriorityFeePerGas: opts.maxFeePerGas,
    }).unsignedSerialized;
    const raw = await opts.runner.call({ to: GAS_PRICE_ORACLE, data: ORACLE_IFACE.encodeFunctionData('getL1Fee', [unsigned]) });
    const [l1Fee] = ORACLE_IFACE.decodeFunctionResult('getL1Fee', raw);
    return preVerificationGasForL1Fee(l1Fee, opts.maxFeePerGas, calldataGas(data));
}
function opTuple(op) {
    return [
        op.sender,
        op.nonce,
        op.initCode,
        op.callData,
        op.accountGasLimits,
        op.preVerificationGas,
        op.gasFees,
        op.paymasterAndData,
        op.signature,
    ];
}
//# sourceMappingURL=preVerificationGas.js.map