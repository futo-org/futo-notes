# Drift watchlist

Moved verbatim from the root `AGENTS.md` §12 (the root manual is held under the 5,000-token limit).

**`scripts/drift-registry.json` is the watchlist** — every permitted duplicate is enumerated there
with its copies and a `lockStatus`; `unlocked` means nothing but you keeps the copies in sync, so
touch all of them in one commit and say so. `just check-drift` is deny-by-default: adding a duplicate
means adding a registry entry. Keep the list there, not here — a prose copy of it is itself drift.

The `notes-root-triplet` unlocked entry is the intentional dev/prod split (M3). Note sort order is
owned only by the Rust store; shells splice engine-reported positions verbatim (ADR-0001), so never
reintroduce a shell comparator or a shell final-id heuristic.
