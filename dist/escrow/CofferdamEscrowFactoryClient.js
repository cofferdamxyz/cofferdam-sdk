// CofferdamEscrowFactoryClient — SDK client for EscrowFactory on Base.
//
// Typed, framework-agnostic client for creating spot (and payroll) escrows
// via the EscrowFactory contract. Uses CREATE2 for deterministic addresses.
//
//   - createSpotEscrow(policy, salt) — deploy a new spot escrow
//   - predictSpotEscrowAddress(policy, salt) — pre-compute the address
//   - authorize / revoke — owner-only access control
//
// The factory enforces access control: only authorized callers can create
// escrows. The deployer is auto-authorized.
import { Contract as EthContract, } from 'ethers';
// ────────────────────────────────────────────────────────────────────────────
// Public ABI fragment
// ────────────────────────────────────────────────────────────────────────────
export const COFFERDAM_ESCROW_FACTORY_ABI = [
    // ── writes ──────────────────────────────────────────────────────────
    'function createSpotEscrow(tuple(address funder, address recruiter, bytes32 workerNullifier, uint32 checkInTimeout, uint32 checkOutTimeout, address witness, address arbiter, uint16 killFeeBps, uint256 amount, bytes32 termsHash, uint64 jobStartTime, uint32 disputeWindow) policy, bytes32 salt) returns (address)',
    'function createPayrollEscrow(address funder, bytes32 companyOrgRoot, tuple(address funder, bytes32 workerRole, uint48 payPeriodEnd, uint32 payInterval) policy, bytes32 salt) returns (address)',
    'function authorize(address caller)',
    'function revoke(address caller)',
    'function transferOwnership(address newOwner)',
    // ── reads ────────────────────────────────────────────────────────────
    'function USDC() view returns (address)',
    'function owner() view returns (address)',
    'function authorizedCallers(address) view returns (bool)',
    'function predictSpotEscrowAddress(tuple(address funder, address recruiter, bytes32 workerNullifier, uint32 checkInTimeout, uint32 checkOutTimeout, address witness, address arbiter, uint16 killFeeBps, uint256 amount, bytes32 termsHash, uint64 jobStartTime, uint32 disputeWindow) policy, bytes32 salt) view returns (address)',
    // ── events ───────────────────────────────────────────────────────────
    'event SpotEscrowCreated(address indexed escrow, address indexed funder, address indexed recruiter, bytes32 workerNullifier, address witness)',
    'event PayrollEscrowCreated(address indexed escrow, address indexed funder, bytes32 workerRole, uint48 payPeriodEnd)',
    'event CallerAuthorized(address indexed caller, address indexed authorizedBy)',
    'event CallerRevoked(address indexed caller, address indexed revokedBy)',
];
// ────────────────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────────────────
export class CofferdamEscrowFactoryClient {
    address;
    signer;
    provider;
    contract;
    readonlyContract;
    iface;
    constructor(config) {
        this.address = config.address;
        this.signer = config.signer;
        const signerProvider = (config.signer.provider ?? null);
        if (!config.provider && !signerProvider) {
            throw new Error('[cofferdam-sdk] CofferdamEscrowFactoryClient: signer has no provider and no fallback provider was supplied.');
        }
        this.provider = config.provider ?? signerProvider;
        this.contract = new EthContract(this.address, COFFERDAM_ESCROW_FACTORY_ABI, config.signer);
        this.readonlyContract = new EthContract(this.address, COFFERDAM_ESCROW_FACTORY_ABI, this.provider);
        this.iface = this.contract.interface;
    }
    // ──────────────────────────────────────────────────────────────────────
    // Reads
    // ──────────────────────────────────────────────────────────────────────
    /** USDC token address used by all escrows created by this factory. */
    async getUSDC() {
        return (await this.readonlyContract.USDC());
    }
    /** Factory owner (can authorize/revoke callers). */
    async getOwner() {
        return (await this.readonlyContract.owner());
    }
    /** Check if an address is authorized to create escrows. */
    async isAuthorized(caller) {
        return (await this.readonlyContract.authorizedCallers(caller));
    }
    /**
     * Pre-compute the spot escrow address before deployment.
     * Uses the same CREATE2 formula as the contract.
     */
    async predictSpotEscrowAddress(policy, salt) {
        return (await this.readonlyContract.predictSpotEscrowAddress(policy, salt));
    }
    // ──────────────────────────────────────────────────────────────────────
    // Writes
    // ──────────────────────────────────────────────────────────────────────
    /**
     * Create a spot escrow via CREATE2. Caller must be authorized.
     * Returns the deployed escrow address.
     */
    async createSpotEscrow(policy, salt, opts = {}) {
        const sent = await this.contract.createSpotEscrow(policy, salt);
        opts.onSent?.(sent.hash);
        const receipt = await sent.wait();
        // Parse SpotEscrowCreated event for the escrow address
        const log = receipt.logs.find((l) => {
            try {
                return this.iface.parseLog(l)?.name === 'SpotEscrowCreated';
            }
            catch {
                return false;
            }
        });
        let escrowAddress = '';
        if (log) {
            const parsed = this.iface.parseLog(log);
            escrowAddress = parsed.args.escrow;
        }
        return { txHash: sent.hash, escrowAddress };
    }
    /** Owner authorizes a caller to create escrows. */
    async authorize(caller, opts = {}) {
        const sent = await this.contract.authorize(caller);
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /** Owner revokes a caller's authorization. */
    async revoke(caller, opts = {}) {
        const sent = await this.contract.revoke(caller);
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /** Owner transfers factory ownership. */
    async transferOwnership(newOwner, opts = {}) {
        const sent = await this.contract.transferOwnership(newOwner);
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
}
//# sourceMappingURL=CofferdamEscrowFactoryClient.js.map