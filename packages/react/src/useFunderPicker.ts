// useFunderPicker — recruiter-side UX state for the corporate posting flow.
//
// Phase α-2 / α-3.
//
// What it does
// ────────────
// In the corporate flow (`OffshoreSyncEscrowClient.postContractIntent`), the
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

import { useCallback, useEffect, useMemo, useState } from 'react'

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface FunderCandidate {
  /** Lowercased 0x-prefixed 40-hex EOA / smart-account address. */
  address: string
  /** Optional display name (e.g. "Maria — TideRunners Finance"). */
  label?: string
  /** Unix ms — set by `recordUsage`. Older entries fall off `maxRecent`. */
  lastUsedAt?: number
}

export interface UseFunderPickerOptions {
  /**
   * Pre-populate the candidate list — e.g. with funders fetched from your
   * backend ("recent suppliers", "designated payers", contact graph, etc).
   * Order is preserved; duplicates with `recent` are deduped by address.
   */
  suggestions?: FunderCandidate[]

  /**
   * localStorage key for persisting recent picks. Defaults to
   * `cofferdam:funders`. Consumers running multiple Cofferdam scopes side
   * by side (e.g. dev + prod, or multi-tenant dashboards) should suffix
   * with their scope: `cofferdam:funders:${scope}`.
   */
  storageKey?: string

  /**
   * Cap on persisted recent entries. Defaults to 8 — UI-friendly without
   * letting the list grow unboundedly across years of use.
   */
  maxRecent?: number

  /**
   * If `true`, addresses passed to `selectFunderByAddress` / `recordUsage`
   * are lowercased before storage. Defaults to `true`. Set to `false` if
   * you want to preserve EIP-55 mixed-case checksums for display.
   */
  normalizeAddresses?: boolean
}

export interface UseFunderPickerResult {
  /** Currently-selected funder, or null if none picked yet. */
  selectedFunder: FunderCandidate | null

  /** Set / clear the selection. */
  selectFunder: (funder: FunderCandidate | null) => void

  /** Convenience for "user pasted/typed an address". */
  selectFunderByAddress: (address: string, label?: string) => void

  /**
   * Deduped, ordered list to render in your UI:
   *   1. recent picks (newest first)
   *   2. suggestions (in their original order)
   * If the same address appears in both, the `recent` entry wins (it has
   * `lastUsedAt`), and the suggestion's `label` is folded in.
   */
  candidates: FunderCandidate[]

  /** Recent picks only (newest first). Bounded by `maxRecent`. */
  recent: FunderCandidate[]

  /** Wipe persisted recent picks. */
  clearRecent: () => void

  /**
   * Bump a funder to "most recent". Call this after a successful funding
   * tx so the next session prioritises whoever just paid. Idempotent.
   */
  recordUsage: (address: string, label?: string) => void

  /**
   * Cheap shape-only check: 0x + 40 hex. Does NOT verify the address is
   * Cofferdam-bound (that's a chain call your app makes via the receiver).
   */
  isValidAddress: (s: string) => boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Hook
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RECENT = 8
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function useFunderPicker(opts: UseFunderPickerOptions = {}): UseFunderPickerResult {
  const storageKey = opts.storageKey ?? 'cofferdam:funders'
  const maxRecent = opts.maxRecent ?? DEFAULT_MAX_RECENT
  const normalize = opts.normalizeAddresses ?? true

  const norm = useCallback(
    (addr: string): string => (normalize ? addr.toLowerCase() : addr),
    [normalize],
  )

  // ── Recent picks (persisted) ────────────────────────────────────────
  const [recent, setRecent] = useState<FunderCandidate[]>(() => loadRecent(storageKey))

  // Re-load when storageKey changes (e.g. scope swap mid-session).
  useEffect(() => {
    setRecent(loadRecent(storageKey))
  }, [storageKey])

  const persistRecent = useCallback(
    (next: FunderCandidate[]) => {
      setRecent(next)
      saveRecent(storageKey, next)
    },
    [storageKey],
  )

  const clearRecent = useCallback(() => {
    persistRecent([])
  }, [persistRecent])

  const recordUsage = useCallback(
    (address: string, label?: string) => {
      const a = norm(address)
      if (!ADDRESS_RE.test(a)) return
      const now = Date.now()
      const filtered = recent.filter((r) => r.address !== a)
      const next: FunderCandidate[] = [
        { address: a, label, lastUsedAt: now },
        ...filtered,
      ].slice(0, maxRecent)
      persistRecent(next)
    },
    [recent, maxRecent, norm, persistRecent],
  )

  // ── Selection state ─────────────────────────────────────────────────
  const [selectedFunder, setSelectedFunder] = useState<FunderCandidate | null>(null)

  const selectFunder = useCallback(
    (funder: FunderCandidate | null) => {
      if (!funder) {
        setSelectedFunder(null)
        return
      }
      setSelectedFunder({ ...funder, address: norm(funder.address) })
    },
    [norm],
  )

  const selectFunderByAddress = useCallback(
    (address: string, label?: string) => {
      const a = norm(address)
      if (!ADDRESS_RE.test(a)) {
        setSelectedFunder(null)
        return
      }
      // Prefer label from the existing candidates list if the caller
      // didn't supply one (e.g. user clicked a suggestion).
      const existing =
        recent.find((r) => r.address === a) ??
        (opts.suggestions ?? []).find((s) => norm(s.address) === a) ??
        null
      setSelectedFunder({
        address: a,
        label: label ?? existing?.label,
        lastUsedAt: existing?.lastUsedAt,
      })
    },
    [norm, recent, opts.suggestions],
  )

  // ── Candidate list (merged + deduped) ──────────────────────────────
  const suggestions = opts.suggestions
  const candidates = useMemo<FunderCandidate[]>(() => {
    const seen = new Map<string, FunderCandidate>()
    for (const r of recent) {
      seen.set(r.address, { ...r })
    }
    for (const s of suggestions ?? []) {
      const a = norm(s.address)
      const prior = seen.get(a)
      if (prior) {
        // Merge label from suggestion if recent didn't have one.
        if (!prior.label && s.label) prior.label = s.label
      } else {
        seen.set(a, { ...s, address: a })
      }
    }
    // Recent first (already in seen-insertion order), then any suggestion-
    // only entries in their original order.
    return Array.from(seen.values())
  }, [recent, suggestions, norm])

  const isValidAddress = useCallback((s: string): boolean => ADDRESS_RE.test(s), [])

  return {
    selectedFunder,
    selectFunder,
    selectFunderByAddress,
    candidates,
    recent,
    clearRecent,
    recordUsage,
    isValidAddress,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ────────────────────────────────────────────────────────────────────────────

function loadRecent(key: string): FunderCandidate[] {
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isFunderCandidate)
  } catch {
    return []
  }
}

function saveRecent(key: string, value: FunderCandidate[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota exceeded / privacy mode — swallow. Picks just won't persist.
  }
}

function isFunderCandidate(x: unknown): x is FunderCandidate {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (typeof o.address !== 'string' || !ADDRESS_RE.test(o.address)) return false
  if (o.label != null && typeof o.label !== 'string') return false
  if (o.lastUsedAt != null && typeof o.lastUsedAt !== 'number') return false
  return true
}
