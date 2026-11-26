// CofferdamEscrowFactoryClient — SDK client for EscrowFactory on Base.
//
// Typed, framework-agnostic client for creating spot (and payroll) escrows
// via the EscrowFactory contract. Uses CREATE2 for deterministic addresses.
//
//   - createSpotEscrow(token, policy, salt) — deploy a new spot escrow
//   - predictSpotEscrowAddress(token, policy, salt) — pre-compute the address
//   - authorize / revoke — owner-only access control
//
// Each escrow holds one ERC-20 named at creation and fixed for its life; the
// factory creates escrows only in tokens on its owner's allowlist (USDC and
// BRS; workspace decision 0100, question 7). `policy.amount` is in that
// token's base units: 1 USDC is 1e6, 1 BRS on Base 1e6, 1 pBRL on Base
// Sepolia 1e18. The factory enforces access control: only authorized callers
// can create escrows. The deployer is auto-authorized.
import { Contract as EthContract, Wallet as EthWallet, JsonRpcProvider as EthProvider, } from 'ethers';
// ────────────────────────────────────────────────────────────────────────────
// Public ABI fragment
// ────────────────────────────────────────────────────────────────────────────
export const COFFERDAM_ESCROW_FACTORY_ABI = [
    // ── writes ──────────────────────────────────────────────────────────
    'function createSpotEscrow(address token, tuple(address funder, address recruiter, bytes32 workerNullifier, uint32 checkInTimeout, uint32 checkOutTimeout, address witness, address arbiter, uint16 killFeeBps, uint256 amount, bytes32 termsHash, uint64 jobStartTime, uint32 disputeWindow) policy, bytes32 salt) returns (address)',
    'function createPayrollEscrow(address token, address funder, bytes32 companyOrgRoot, tuple(address worker, bytes32 workerRole, bytes32 managerRole, uint48 payPeriodStart, uint48 payPeriodEnd, uint32 releaseDelay, uint32 disputeWindow, bool managerApproval) policy, bytes32 salt) returns (address)',
    'function allowToken(address token)',
    'function disallowToken(address token)',
    'function authorize(address caller)',
    'function revoke(address caller)',
    'function transferOwnership(address newOwner)',
    // ── reads ────────────────────────────────────────────────────────────
    'function owner() view returns (address)',
    'function authorizedCallers(address) view returns (bool)',
    'function allowedTokens(address) view returns (bool)',
    'function predictSpotEscrowAddress(address token, tuple(address funder, address recruiter, bytes32 workerNullifier, uint32 checkInTimeout, uint32 checkOutTimeout, address witness, address arbiter, uint16 killFeeBps, uint256 amount, bytes32 termsHash, uint64 jobStartTime, uint32 disputeWindow) policy, bytes32 salt) view returns (address)',
    // ── events ───────────────────────────────────────────────────────────
    'event SpotEscrowCreated(address indexed escrow, address indexed funder, address indexed recruiter, address token, bytes32 workerNullifier, address witness)',
    'event PayrollEscrowCreated(address indexed escrow, address indexed funder, address indexed token, bytes32 workerRole, uint48 payPeriodEnd)',
    'event TokenAllowed(address indexed token, uint8 decimals, address indexed allowedBy)',
    'event TokenDisallowed(address indexed token, address indexed disallowedBy)',
    'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
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
     * Uses the same CREATE2 formula as the contract; the token is part of it.
     * Does not check the allowlist (`createSpotEscrow` does).
     */
    async predictSpotEscrowAddress(token, policy, salt) {
        return (await this.readonlyContract.predictSpotEscrowAddress(token, policy, salt));
    }
    // ──────────────────────────────────────────────────────────────────────
    // Writes
    // ──────────────────────────────────────────────────────────────────────
    /**
     * Create a spot escrow via CREATE2 in `token`, which must be on the
     * factory's allowlist. Caller must be authorized. `policy.amount` is in
     * the token's base units. Returns the deployed escrow address.
     */
    async createSpotEscrow(token, policy, salt, opts = {}) {
        const sent = await this.contract.createSpotEscrow(token, policy, salt);
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