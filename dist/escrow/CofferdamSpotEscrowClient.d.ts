import { Wallet as EthWallet, JsonRpcProvider as EthProvider } from 'ethers';
export declare const COFFERDAM_SPOT_ESCROW_ABI: readonly ["function awardWorker(address worker) external", "function fund(uint256 amount) external", "function setWitness(address newWitness) external", "function checkIn(address worker) external", "function checkOut() external", "function cancel() external", "function refund() external", "function reclaimNoShow() external", "function claimAfterCheckoutTimeout() external", "function raiseDispute(bytes32 reason) external", "function resolveDispute(uint256 workerAmount) external", "function claimAfterDisputeTimeout() external", "function USDC() view returns (address)", "function selfWitnessed() view returns (bool)", "function policy() view returns (tuple(address funder, address recruiter, bytes32 workerNullifier, uint32 checkInTimeout, uint32 checkOutTimeout, address witness, address arbiter, uint16 killFeeBps, uint256 amount, bytes32 termsHash, uint64 jobStartTime, uint32 disputeWindow))", "function state() view returns (uint8)", "function fundedAmount() view returns (uint256)", "function createdAt() view returns (uint256)", "function checkedInAt() view returns (uint256)", "function checkedOutAt() view returns (uint256)", "function worker() view returns (address)", "function awardedWorker() view returns (address)", "function disputeReason() view returns (bytes32)", "function disputedAt() view returns (uint256)", "function witnessHistoryCount() view returns (uint256)", "function witnessHistory(uint256 index) view returns (address witness, address assignedBy, uint64 timestamp)", "event EscrowStateChanged(uint256 indexed escrowId, uint8 fromState, uint8 toState, address indexed actor, uint64 timestamp, bytes32 proofHash)", "event EscrowFunded(uint256 indexed escrowId, uint256 amount, address indexed funder)", "event EscrowReleased(uint256 indexed escrowId, uint256 amount, address indexed worker)", "event EscrowRefunded(uint256 indexed escrowId, uint256 amount, address indexed funder)", "event WitnessAssigned(address indexed witness, address indexed assignedBy)", "event WitnessReplaced(address indexed oldWitness, address indexed newWitness, address indexed replacedBy)", "event WorkerAwarded(address indexed worker, address indexed awardedBy)", "event KillFeePaid(address indexed worker, uint256 amount, address indexed funder)", "event EscrowDisputed(uint256 indexed escrowId, address indexed disputer, bytes32 reason)", "event DisputeResolved(address indexed worker, uint256 workerAmount, address indexed funder, uint256 funderAmount, address indexed arbiter)"];
export type EscrowState = 'Created' | 'Funded' | 'Active' | 'Pending' | 'Released' | 'Disputed' | 'Cancelled' | 'Refunded' | 'Void';
export interface CofferdamSpotEscrowClientConfig {
    /** Deployed `CofferdamSpotEscrow` address. */
    address: string;
    /** Wallet that will sign + send state-mutating txs. */
    signer: EthWallet;
    /** Optional read-only provider. Defaults to `signer.provider`. */
    provider?: EthProvider;
}
export interface TxResult {
    txHash: string;
}
export interface TxOptions {
    onSent?: (txHash: string) => void;
}
export interface SpotEscrowPolicy {
    funder: string;
    recruiter: string;
    workerNullifier: string;
    checkInTimeout: number;
    checkOutTimeout: number;
    witness: string;
    arbiter: string;
    killFeeBps: number;
    amount: bigint;
    termsHash: string;
    jobStartTime: number;
    disputeWindow: number;
}
export interface SpotEscrowState {
    state: EscrowState;
    fundedAmount: bigint;
    createdAt: number;
    checkedInAt: number;
    checkedOutAt: number;
    worker: string;
    awardedWorker: string;
}
export declare class CofferdamSpotEscrowClient {
    readonly address: string;
    readonly signer: EthWallet;
    readonly provider: EthProvider;
    private readonly contract;
    private readonly readonlyContract;
    private readonly iface;
    constructor(config: CofferdamSpotEscrowClientConfig);
    /**
     * Recruiter awards a worker after candidate review. Must be called
     * AFTER `fund()` and before check-in. Escrow must be in `Funded` state.
     */
    awardWorker(worker: string, opts?: TxOptions): Promise<TxResult>;
    /**
     * Funder deposits USDC into the escrow. Caller must be the policy funder
     * and must have approved USDC for the escrow contract first (see
     * `approveUSDC`). Escrow must be in `Created` state. The worker is awarded
     * right after funding (see `awardWorker`).
     */
    fund(amount: bigint, opts?: TxOptions): Promise<TxResult>;
    /**
     * Approve USDC transfer for the escrow contract. Must be called by the
     * funder before `fund()`. Uses the USDC address from the contract.
     */
    approveUSDC(amount: bigint, opts?: TxOptions): Promise<TxResult>;
    /**
     * Witness check-in. Only the assigned witness can call this.
     * Escrow must be in `Funded` state and within `checkInTimeout`.
     */
    checkIn(worker: string, opts?: TxOptions): Promise<TxResult>;
    /**
     * Witness check-out. Only the assigned witness can call this.
     * Auto-releases USDC to the worker. Escrow in `Active`.
     */
    checkOut(opts?: TxOptions): Promise<TxResult>;
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
    setWitness(newWitness: string, opts?: TxOptions): Promise<TxResult>;
    /** Funder cancels before funding. Escrow in `Created`. */
    cancel(opts?: TxOptions): Promise<TxResult>;
    /**
     * Funder cancels a funded escrow before the worker checks in (within the
     * check-in window). The awarded worker is paid a kill fee (killFeeBps);
     * the remainder returns to the funder. Escrow in `Funded`.
     */
    refund(opts?: TxOptions): Promise<TxResult>;
    /**
     * Funder reclaims the FULL amount when the worker never checked in by the
     * deadline (no-show). No kill fee. Escrow in `Funded`, after checkInTimeout.
     */
    reclaimNoShow(opts?: TxOptions): Promise<TxResult>;
    /**
     * Worker claims funds when the company-appointed witness failed to check
     * them out within `checkOutTimeout`. Permissionless — funds go to the
     * predetermined worker. Escrow in `Active`, after checkOutTimeout.
     */
    claimAfterCheckoutTimeout(opts?: TxOptions): Promise<TxResult>;
    /**
     * Either party (funder, awarded worker, or witness) escalates to the
     * neutral arbiter. `reason` is a bytes32 hash. Escrow in `Funded`/`Active`.
     */
    raiseDispute(reason: string, opts?: TxOptions): Promise<TxResult>;
    /**
     * Neutral arbiter resolves a dispute by splitting the funded amount:
     * `workerAmount` to the worker, remainder to the funder. Escrow in
     * `Disputed`. Caller must be the policy arbiter.
     */
    resolveDispute(workerAmount: bigint, opts?: TxOptions): Promise<TxResult>;
    /**
     * If the arbiter never resolves a dispute within disputeWindow, the worker
     * claims the full amount. Permissionless — funds can only go to the
     * predetermined worker. Escrow in `Disputed`.
     */
    claimAfterDisputeTimeout(opts?: TxOptions): Promise<TxResult>;
    /** USDC token address used by this escrow. */
    getUSDC(): Promise<string>;
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
    isSelfWitnessed(): Promise<boolean>;
    /** Escrow policy (funder, recruiter, workerNullifier, timeouts, witness). */
    getPolicy(): Promise<SpotEscrowPolicy>;
    /** Current escrow state + key fields. */
    getState(): Promise<SpotEscrowState>;
    static hashTerms(terms: string | Record<string, unknown>): string;
}
//# sourceMappingURL=CofferdamSpotEscrowClient.d.ts.map