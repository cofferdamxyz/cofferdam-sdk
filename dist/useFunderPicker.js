// useFunderPicker — recruiter-side UX state for the corporate posting flow.
//
// Phase α-2 / α-3.
//
// What it does
// ────────────
// In the corporate flow (`CofferdamSpotEscrowClient.postContractIntent`), the
// recruiter (HR) has to name a `designatedFunder` — the Finance / Treasury
// account that's authorised to lock funds against the draft. This hook
// owns the React-side state for picking that funder:
//
//   - keeps a deduped list of candidates merging:
//       • caller-supplied suggestions (e.g. fetched from the consumer
//         app's backend "people you've worked with at company X" graph)
//       • locally-persisted recent picks (localStorage, keyed by scope)
//   - tracks the currently-selected funder
//   - validates pasted addresses cheaply (shape only, not on-chain)
//   - exposes `recordUsage(addr)` so the consumer can bump a funder to
//     "most recent" after a successful funding tx
//
// What it is NOT
// ──────────────
// - Not a contact-graph fetcher. It doesn't know about Cofferdam Partners,
//   Self.xyz attesters, or any backend — the consumer wires that in via
//   the `suggestions` option.
// - Not a chain call site. It does NOT verify on-chain that the picked
//   address is Cofferdam-bound. The escrow contract enforces that itself
//   at funding time (`onlyBoundAccount`). For pre-flight verification,
//   call `receiver.isAccountBound(addr)` from your app code.
// - Not a server-synced store. Recent picks are local-only. If you need
//   cross-device sync, mirror `recordUsage` to your backend.
import { useCallback, useEffect, useMemo, useState } from 'react';
// ────────────────────────────────────────────────────────────────────────────
// Hook
// ────────────────────────────────────────────────────────────────────────────
const DEFAULT_MAX_RECENT = 8;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export function useFunderPicker(opts = {}) {
    const storageKey = opts.storageKey ?? 'cofferdam:funders';
    const maxRecent = opts.maxRecent ?? DEFAULT_MAX_RECENT;
    const normalize = opts.normalizeAddresses ?? true;
    const norm = useCallback((addr) => (normalize ? addr.toLowerCase() : addr), [normalize]);
    // ── Recent picks (persisted) ────────────────────────────────────────
    const [recent, setRecent] = useState(() => loadRecent(storageKey));
    // Re-load when storageKey changes (e.g. scope swap mid-session).
    useEffect(() => {
        setRecent(loadRecent(storageKey));
    }, [storageKey]);
    const persistRecent = useCallback((next) => {
        setRecent(next);
        saveRecent(storageKey, next);
    }, [storageKey]);
    const clearRecent = useCallback(() => {
        persistRecent([]);
    }, [persistRecent]);
    const recordUsage = useCallback((address, label) => {
        const a = norm(address);
        if (!ADDRESS_RE.test(a))
            return;
        const now = Date.now();
        const filtered = recent.filter((r) => r.address !== a);
        const next = [
            { address: a, label, lastUsedAt: now },
            ...filtered,
        ].slice(0, maxRecent);
        persistRecent(next);
    }, [recent, maxRecent, norm, persistRecent]);
    // ── Selection state ─────────────────────────────────────────────────
    const [selectedFunder, setSelectedFunder] = useState(null);
    const selectFunder = useCallback((funder) => {
        if (!funder) {
            setSelectedFunder(null);
            return;
        }
        setSelectedFunder({ ...funder, address: norm(funder.address) });
    }, [norm]);
    const selectFunderByAddress = useCallback((address, label) => {
        const a = norm(address);
        if (!ADDRESS_RE.test(a)) {
            setSelectedFunder(null);
            return;
        }
        // Prefer label from the existing candidates list if the caller
        // didn't supply one (e.g. user clicked a suggestion).
        const existing = recent.find((r) => r.address === a) ??
            (opts.suggestions ?? []).find((s) => norm(s.address) === a) ??
            null;
        setSelectedFunder({
            address: a,
            label: label ?? existing?.label,
            lastUsedAt: existing?.lastUsedAt,
        });
    }, [norm, recent, opts.suggestions]);
    // ── Candidate list (merged + deduped) ──────────────────────────────
    const suggestions = opts.suggestions;
    const candidates = useMemo(() => {
        const seen = new Map();
        for (const r of recent) {
            seen.set(r.address, { ...r });
        }
        for (const s of suggestions ?? []) {
            const a = norm(s.address);
            const prior = seen.get(a);
            if (prior) {
                // Merge label from suggestion if recent didn't have one.
                if (!prior.label && s.label)
                    prior.label = s.label;
            }
            else {
                seen.set(a, { ...s, address: a });
            }
        }
        // Recent first (already in seen-insertion order), then any suggestion-
        // only entries in their original order.
        return Array.from(seen.values());
    }, [recent, suggestions, norm]);
    const isValidAddress = useCallback((s) => ADDRESS_RE.test(s), []);
    return {
        selectedFunder,
        selectFunder,
        selectFunderByAddress,
        candidates,
        recent,
        clearRecent,
        recordUsage,
        isValidAddress,
    };
}
// ────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ────────────────────────────────────────────────────────────────────────────
function loadRecent(key) {
    if (typeof window === 'undefined' || !window.localStorage)
        return [];
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter(isFunderCandidate);
    }
    catch {
        return [];
    }
}
function saveRecent(key, value) {
    if (typeof window === 'undefined' || !window.localStorage)
        return;
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    }
    catch {
        // Quota exceeded / privacy mode — swallow. Picks just won't persist.
    }
}
function isFunderCandidate(x) {
    if (!x || typeof x !== 'object')
        return false;
    const o = x;
    if (typeof o.address !== 'string' || !ADDRESS_RE.test(o.address))
        return false;
    if (o.label != null && typeof o.label !== 'string')
        return false;
    if (o.lastUsedAt != null && typeof o.lastUsedAt !== 'number')
        return false;
    return true;
}
//# sourceMappingURL=useFunderPicker.js.map