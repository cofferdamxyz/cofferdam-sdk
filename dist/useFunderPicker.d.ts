export interface FunderCandidate {
    /** Lowercased 0x-prefixed 40-hex EOA / smart-account address. */
    address: string;
    /** Optional display name (e.g. "Maria — TideRunners Finance"). */
    label?: string;
    /** Unix ms — set by `recordUsage`. Older entries fall off `maxRecent`. */
    lastUsedAt?: number;
}
export interface UseFunderPickerOptions {
    /**
     * Pre-populate the candidate list — e.g. with funders fetched from your
     * backend ("recent suppliers", "designated payers", contact graph, etc).
     * Order is preserved; duplicates with `recent` are deduped by address.
     */
    suggestions?: FunderCandidate[];
    /**
     * localStorage key for persisting recent picks. Defaults to
     * `cofferdam:funders`. Consumers running multiple Cofferdam scopes side
     * by side (e.g. dev + prod, or multi-tenant dashboards) should suffix
     * with their scope: `cofferdam:funders:${scope}`.
     */
    storageKey?: string;
    /**
     * Cap on persisted recent entries. Defaults to 8 — UI-friendly without
     * letting the list grow unboundedly across years of use.
     */
    maxRecent?: number;
    /**
     * If `true`, addresses passed to `selectFunderByAddress` / `recordUsage`
     * are lowercased before storage. Defaults to `true`. Set to `false` if
     * you want to preserve EIP-55 mixed-case checksums for display.
     */
    normalizeAddresses?: boolean;
}
export interface UseFunderPickerResult {
    /** Currently-selected funder, or null if none picked yet. */
    selectedFunder: FunderCandidate | null;
    /** Set / clear the selection. */
    selectFunder: (funder: FunderCandidate | null) => void;
    /** Convenience for "user pasted/typed an address". */
    selectFunderByAddress: (address: string, label?: string) => void;
    /**
     * Deduped, ordered list to render in your UI:
     *   1. recent picks (newest first)
     *   2. suggestions (in their original order)
     * If the same address appears in both, the `recent` entry wins (it has
     * `lastUsedAt`), and the suggestion's `label` is folded in.
     */
    candidates: FunderCandidate[];
    /** Recent picks only (newest first). Bounded by `maxRecent`. */
    recent: FunderCandidate[];
    /** Wipe persisted recent picks. */
    clearRecent: () => void;
    /**
     * Bump a funder to "most recent". Call this after a successful funding
     * tx so the next session prioritises whoever just paid. Idempotent.
     */
    recordUsage: (address: string, label?: string) => void;
    /**
     * Cheap shape-only check: 0x + 40 hex. Does NOT verify the address is
     * Cofferdam-bound (that's a chain call your app makes via the receiver).
     */
    isValidAddress: (s: string) => boolean;
}
export declare function useFunderPicker(opts?: UseFunderPickerOptions): UseFunderPickerResult;
//# sourceMappingURL=useFunderPicker.d.ts.map