// CofferdamSpotEscrowClient — Base single-instance escrow client.
//
// Typed, framework-agnostic client for the CofferdamSpotEscrow contract
// on Base. Each escrow is its own contract instance deployed by
// EscrowFactory.createSpotEscrow(policy). This client wraps one instance
// with:
//
//   - Full lifecycle  — `fund`, `setWitness`, `checkIn`, `checkOut`,
//                        `cancel`, `refund`, `voidEscrow`
//   - State reads     — `getState()`, `getPolicy()`, `getUSDC()`
//   - USDC approval   — `approveUSDC()` helper for the funder
//
// The contract is USDC-based (not ETH). The funder must approve USDC
// transfer before calling `fund()`. The flow is:
//   deploy → fund → setWitness? → checkIn(worker) → checkOut()
//                          ↑ HR         ↑ witness       ↑ witness (auto-release)
import { Contract as EthContract, keccak256, toUtf8Bytes, } from 'ethers';
// ────────────────────────────────────────────────────────────────────────────
// Public ABI fragment
// ────────────────────────────────────────────────────────────────────────────
export const COFFERDAM_SPOT_ESCROW_ABI = [
    // ── lifecycle ───────────────────────────────────────────────────────
    'function awardWorker(address worker) external',
    'function fund(uint256 amount) external',
    'function setWitness(address newWitness) external',
    'function checkIn(address worker) external',
    'function checkOut() external',
    'function cancel() external',
    'function refund() external',
    'function reclaimNoShow() external',
    'function claimAfterCheckoutTimeout() external',
    'function raiseDispute(bytes32 reason) external',
    'function resolveDispute(uint256 workerAmount) external',
    'function claimAfterDisputeTimeout() external',
    // ── reads ────────────────────────────────────────────────────────────
    'function USDC() view returns (address)',
    'function selfWitnessed() view returns (bool)',
    'function policy() view returns (tuple(address funder, address recruiter, bytes32 workerNullifier, uint32 checkInTimeout, uint32 checkOutTimeout, address witness, address arbiter, uint16 killFeeBps, uint256 amount, bytes32 termsHash, uint64 jobStartTime, uint32 disputeWindow))',
    'function state() view returns (uint8)',
    'function fundedAmount() view returns (uint256)',
    'function createdAt() view returns (uint256)',
    'function checkedInAt() view returns (uint256)',
    'function checkedOutAt() view returns (uint256)',
    'function worker() view returns (address)',
    'function awardedWorker() view returns (address)',
    'function disputeReason() view returns (bytes32)',
    'function disputedAt() view returns (uint256)',
    'function witnessHistoryCount() view returns (uint256)',
    'function witnessHistory(uint256 index) view returns (address witness, address assignedBy, uint64 timestamp)',
    // ── events ───────────────────────────────────────────────────────────
    'event EscrowStateChanged(uint256 indexed escrowId, uint8 fromState, uint8 toState, address indexed actor, uint64 timestamp, bytes32 proofHash)',
    'event EscrowFunded(uint256 indexed escrowId, uint256 amount, address indexed funder)',
    'event EscrowReleased(uint256 indexed escrowId, uint256 amount, address indexed worker)',
    'event EscrowRefunded(uint256 indexed escrowId, uint256 amount, address indexed funder)',
    'event WitnessAssigned(address indexed witness, address indexed assignedBy)',
    'event WitnessReplaced(address indexed oldWitness, address indexed newWitness, address indexed replacedBy)',
    'event WorkerAwarded(address indexed worker, address indexed awardedBy)',
    'event KillFeePaid(address indexed worker, uint256 amount, address indexed funder)',
    'event EscrowDisputed(uint256 indexed escrowId, address indexed disputer, bytes32 reason)',
    'event DisputeResolved(address indexed worker, uint256 workerAmount, address indexed funder, uint256 funderAmount, address indexed arbiter)',
];
const STATE_BY_INDEX = [
    'Created',
    'Funded',
    'Active',
    'Pending',
    'Released',
    'Disputed',
    'Cancelled',
    'Refunded',
    'Void',
];
// ────────────────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────────────────
export class CofferdamSpotEscrowClient {
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
            throw new Error('[cofferdam-sdk] CofferdamSpotEscrowClient: signer has no provider and no fallback provider was supplied.');
        }
        this.provider = config.provider ?? signerProvider;
        this.contract = new EthContract(this.address, COFFERDAM_SPOT_ESCROW_ABI, config.signer);
        this.readonlyContract = new EthContract(this.address, COFFERDAM_SPOT_ESCROW_ABI, this.provider);
        this.iface = this.contract.interface;
    }
    // ──────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ──────────────────────────────────────────────────────────────────────
    /**
     * Recruiter awards a worker after candidate review. Must be called
     * AFTER `fund()` and before check-in. Escrow must be in `Funded` state.
     */
    async awardWorker(worker, opts = {}) {
        const sent = await this.contract.awardWorker(worker);
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * Funder deposits USDC into the escrow. Caller must be the policy funder
     * and must have approved USDC for the escrow contract first (see
     * `approveUSDC`). Escrow must be in `Created` state. The worker is awarded
     * right after funding (see `awardWorker`).
     */
    async fund(amount, opts = {}) {
        const sent = await this.contract.fund(amount);
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * Approve USDC transfer for the escrow contract. Must be called by the
     * funder before `fund()`. Uses the USDC address from the contract.
     */
    async approveUSDC(amount, opts = {}) {
        const usdcAddr = await this.getUSDC();
        const erc20Abi = ['function approve(address spender, uint256 amount) returns (bool)'];
        const usdc = new EthContract(usdcAddr, erc20Abi, this.signer);
        const sent = await usdc.approve(this.address, amount);
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * Witness check-in. Only the assigned witness can call this.
     * Escrow must be in `Funded` state and within `checkInTimeout`.
     */
    async checkIn(worker, opts = {}) {
        const sent = await this.contract.checkIn(worker);
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * Witness check-out. Only the assigned witness can call this.
     * Auto-releases USDC to the worker. Escrow in `Active`.
     */
    async checkOut(opts = {}) {
        const sent = await this.contract.checkOut();
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * Recruiter assigns or replaces the witness. Callable in `Created`,
     * `Funded` or `Active` — including **mid-job**, so a supervisor who rotates
     * off while the worker is still on site can hand over. Authority moves
     * immediately: the incoming witness can check out a worker the outgoing one
     * checked in, and no deadline is affected by the swap. Every assignment is
     * appended to `witnessHistory`.
     *
     * Rejected once the escrow is settled, and while a dispute is open (the
     * witness counts as a party to a dispute, so swapping would change who has
     * standing).
     *
     * `newWitness` may not be the arbiter, the awarded worker, the checked-in
     * worker, or the current witness. It may not be the funder either — unless
     * the escrow is **self-witnessed** (see `isSelfWitnessed`), in which case
     * the hirer may hand duty to a stand-in and later resume it.
     *
     * Note the witness can never redirect funds: `checkOut` always pays the
     * awarded worker. Delegating this role transfers timing authority only.
     */
    async setWitness(newWitness, opts = {}) {
        const sent = await this.contract.setWitness(newWitness);
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /** Funder cancels before funding. Escrow in `Created`. */
    async cancel(opts = {}) {
        const sent = await this.contract.cancel();
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * Funder cancels a funded escrow before the worker checks in (within the
     * check-in window). The awarded worker is paid a kill fee (killFeeBps);
     * the remainder returns to the funder. Escrow in `Funded`.
     */
    async refund(opts = {}) {
        const sent = await this.contract.refund();
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * Funder reclaims the FULL amount when the worker never checked in by the
     * deadline (no-show). No kill fee. Escrow in `Funded`, after checkInTimeout.
     */
    async reclaimNoShow(opts = {}) {
        const sent = await this.contract.reclaimNoShow();
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * Worker claims funds when the company-appointed witness failed to check
     * them out within `checkOutTimeout`. Permissionless — funds go to the
     * predetermined worker. Escrow in `Active`, after checkOutTimeout.
     */
    async claimAfterCheckoutTimeout(opts = {}) {
        const sent = await this.contract.claimAfterCheckoutTimeout();
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * Either party (funder, awarded worker, or witness) escalates to the
     * neutral arbiter. `reason` is a bytes32 hash. Escrow in `Funded`/`Active`.
     */
    async raiseDispute(reason, opts = {}) {
        const sent = await this.contract.raiseDispute(reason);
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * Neutral arbiter resolves a dispute by splitting the funded amount:
     * `workerAmount` to the worker, remainder to the funder. Escrow in
     * `Disputed`. Caller must be the policy arbiter.
     */
    async resolveDispute(workerAmount, opts = {}) {
        const sent = await this.contract.resolveDispute(workerAmount);
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    /**
     * If the arbiter never resolves a dispute within disputeWindow, the worker
     * claims the full amount. Permissionless — funds can only go to the
     * predetermined worker. Escrow in `Disputed`.
     */
    async claimAfterDisputeTimeout(opts = {}) {
        const sent = await this.contract.claimAfterDisputeTimeout();
        opts.onSent?.(sent.hash);
        await sent.wait();
        return { txHash: sent.hash };
    }
    // ──────────────────────────────────────────────────────────────────────
    // Reads
    // ──────────────────────────────────────────────────────────────────────
    /** USDC token address used by this escrow. */
    async getUSDC() {
        return (await this.readonlyContract.USDC());
    }
    /**
     * True when the escrow was created with `funder == witness` — the consumer
     * shape, where one hirer pays for and attests the work because there is no
     * separate on-site supervisor to appoint. Immutable, fixed at creation.
     *
     * The only behavioural difference is in `setWitness`: a self-witnessed
     * escrow's funder may take the witness seat, so a hirer who delegates to a
     * stand-in while away can resume the role on return. In a B2B escrow the
     * funder is permanently barred from attesting, keeping Finance separate from
     * the party certifying the work.
     *
     * Useful for deciding whether to offer a "take witness duty back" action in
     * a hirer-facing UI.
     */
    async isSelfWitnessed() {
        return (await this.readonlyContract.selfWitnessed());
    }
    /** Escrow policy (funder, recruiter, workerNullifier, timeouts, witness). */
    async getPolicy() {
        const raw = await this.readonlyContract.policy();
        return {
            funder: raw.funder,
            recruiter: raw.recruiter,
            workerNullifier: raw.workerNullifier,
            checkInTimeout: Number(raw.checkInTimeout),
            checkOutTimeout: Number(raw.checkOutTimeout),
            witness: raw.witness,
            arbiter: raw.arbiter,
            killFeeBps: Number(raw.killFeeBps),
            amount: BigInt(raw.amount),
            termsHash: raw.termsHash,
            jobStartTime: Number(raw.jobStartTime),
            disputeWindow: Number(raw.disputeWindow),
        };
    }
    /** Current escrow state + key fields. */
    async getState() {
        const [stateRaw, fundedAmount, createdAt, checkedInAt, checkedOutAt, worker, awardedWorker] = await Promise.all([
            this.readonlyContract.state(),
            this.readonlyContract.fundedAmount(),
            this.readonlyContract.createdAt(),
            this.readonlyContract.checkedInAt(),
            this.readonlyContract.checkedOutAt(),
            this.readonlyContract.worker(),
            this.readonlyContract.awardedWorker(),
        ]);
        const stateIdx = Number(stateRaw);
        const state = STATE_BY_INDEX[stateIdx];
        if (!state) {
            throw new Error(`[cofferdam-sdk] getState: unknown state index ${stateIdx}`);
        }
        return {
            state,
            fundedAmount: fundedAmount,
            createdAt: Number(createdAt),
            checkedInAt: Number(checkedInAt),
            checkedOutAt: Number(checkedOutAt),
            worker,
            awardedWorker,
        };
    }
    // ──────────────────────────────────────────────────────────────────────
    // Static helpers
    // ──────────────────────────────────────────────────────────────────────
    static hashTerms(terms) {
        const text = typeof terms === 'string' ? terms : JSON.stringify(terms);
        return keccak256(toUtf8Bytes(text));
    }
}
//# sourceMappingURL=CofferdamSpotEscrowClient.js.map