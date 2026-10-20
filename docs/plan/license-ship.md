# Plan: ship the paid client license on desktop, iOS and Android

Status: decisions taken 2026-09-16 by @justin; implementation not started.
Branch: `feat/license` (MR !303, draft). Behavioral truth: `docs/spec/license.md`.
Design: the "Steel Ledger" artboard on the design canvas, version 4 (ring removed) —
<https://claude.ai/artifact/A4wh9z11msn9RVY6LRoNMj>.

This plan is written for an implementing agent. Read root `AGENTS.md`, then
`src/AGENTS.md`, `crates/futo-notes-license/AGENTS.md`, `apps/tauri/AGENTS.md`,
`apps/ios/AGENTS.md`, `apps/android/AGENTS.md` and `docs/spec/AGENTS.md` before
touching their layers. Every phase ends with the verification listed for it and a
commit in `type(scope): imperative summary` form with a `Verified:` line.

- [0. Decisions (locked — do not reopen without @justin)](license-ship/0-decisions.md)
- [1. State of the branch on 2026-09-16 (read before starting)](license-ship/1-state-of-the-branch.md)
- [2. Copy: the catalog after this plan](license-ship/2-copy-the-catalog.md)
- [3. The shared view-model (drift-registered)](license-ship/3-shared-view-model.md)
- [4. Rust: the key crosses the boundary](license-ship/4-rust-key-crosses-boundary.md)
- [5. Phases](license-ship/5-phases.md)
- [6. Verification chains (what "done" means per layer)](license-ship/6-verification-chains.md)
- [7. Traps specific to this work](license-ship/7-traps.md)
- [8. Execution log (living — append only)](license-ship/8-execution-log.md)
- [Phase 9 — the coin gets its shape back, and starts turning on mobile — 2026-09-16](license-ship/phase-9-coin-shape.md)
