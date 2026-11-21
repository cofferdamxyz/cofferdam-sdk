import { Wallet as EthWallet, JsonRpcProvider as EthProvider } from 'ethers';
import type { SpotEscrowPolicy } from './CofferdamSpotEscrowClient';
export declare const COFFERDAM_ESCROW_FACTORY_ABI: readonly ["function createSpotEscrow(tuple(address funder, address recruiter, bytes32 workerNullifier, uint32 checkInTimeout, uint32 checkOutTimeout, address witness, address arbiter, uint16 killFeeBps, uint256 amount, bytes32 termsHash, uint64 jobStartTime, uint32 disputeWindow) policy, bytes32 salt) returns (address)", "function createPayrollEscrow(address funder, bytes32 companyOrgRoot, tuple(address funder, bytes32 workerRole, uint48 payPeriodEnd, uint32 payInterval) policy, bytes32 salt) returns (address)", "function authorize(address caller)", "function revoke(address caller)", "function transferOwnership(address newOwner)", "function USDC() view returns (address)", "function owner() view returns (address)", "function authorizedCallers(address) view returns (bool)", "function predictSpotEscrowAddress(tuple(address funder, address recruiter, bytes32 workerNullifier, uint32 checkInTimeout, uint32 checkOutTimeout, address witness, address arbiter, uint16 killFeeBps, uint256 amount, bytes32 termsHash, uint64 jobStartTime, uint32 disputeWindow) policy, bytes32 salt) view returns (address)", "event SpotEscrowCreated(address indexed escrow, address indexed funder, address indexed recruiter, bytes32 workerNullifier, address witness)", "event PayrollEscrowCreated(address indexed escrow, address indexed funder, bytes32 workerRole, uint48 payPeriodEnd)", "event CallerAuthorized(address indexed caller, address indexed authorizedBy)", "event CallerRevoked(address indexed caller, address indexed revokedBy)"];
export interface CofferdamEscrowFactoryClientConfig {
    /** Deployed `EscrowFactory` address. */
    address: string;
    /** Wallet that will sign + send state-mutating txs. */
    signer: EthWallet;
    /** Optional read-only provider. Defaults to `signer.provider`. */
    provider?: EthProvider;
}
export interface TxResult {
    txHash: string;
    escrowAddress: string;
}
export interface TxOptions {
    onSent?: (txHash: string) => void;
}
export declare class CofferdamEscrowFactoryClient {
    readonly address: string;
    readonly signer: EthWallet;
    readonly provider: EthProvider;
    private readonly contract;
    private readonly readonlyContract;
    private readonly iface;
    constructor(config: CofferdamEscrowFactoryClientConfig);
    /** USDC token address used by all escrows created by this factory. */
    getUSDC(): Promise<string>;
    /** Factory owner (can authorize/revoke callers). */
    getOwner(): Promise<string>;
    /** Check if an address is authorized to create escrows. */
    isAuthorized(caller: string): Promise<boolean>;
    /**
     * Pre-compute the spot escrow address before deployment.
     * Uses the same CREATE2 formula as the contract.
     */
    predictSpotEscrowAddress(policy: SpotEscrowPolicy, salt: string): Promise<string>;
    /**
     * Create a spot escrow via CREATE2. Caller must be authorized.
     * Returns the deployed escrow address.
     */
    createSpotEscrow(policy: SpotEscrowPolicy, salt: string, opts?: TxOptions): Promise<TxResult>;
    /** Owner authorizes a caller to create escrows. */
    authorize(caller: string, opts?: TxOptions): Promise<{
        txHash: string;
    }>;
    /** Owner revokes a caller's authorization. */
    revoke(caller: string, opts?: TxOptions): Promise<{
        txHash: string;
    }>;
    /** Owner transfers factory ownership. */
    transferOwnership(newOwner: string, opts?: TxOptions): Promise<{
        txHash: string;
    }>;
}
//# sourceMappingURL=CofferdamEscrowFactoryClient.d.ts.map