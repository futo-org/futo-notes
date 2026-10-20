## 8. Execution log (living — append only)

Each phase appends its own block here when it lands: what changed, the exact
commands run and their results, and anything the next phase must know. **Append
only** — parallel lanes write to this file, so never rewrite or reflow someone
else's block.

- [Phase 1 — make the branch honest — DONE 2026-09-16](8-execution-log/phase-1-branch-honest.md)
- [Phase 3 — Rust and TS contract: the key — DONE 2026-09-16](8-execution-log/phase-3-rust-ts-contract.md)
- [Phase 1.4 — first sighting of the coin — 2026-09-16](8-execution-log/phase-1-4-first-sighting-of-the-coin.md)
- [Phase 2 — copy and view-model — DONE 2026-09-16](8-execution-log/phase-2-copy-and-view-model.md)
- [Side finding — the Android IME test red is not ours — 2026-09-16](8-execution-log/side-finding-android-ime-test.md)
- [Phase 4 — desktop plate — DONE 2026-09-16](8-execution-log/phase-4-desktop-plate.md)
- [Phase 5 (Android) — native plate — DONE 2026-09-16](8-execution-log/phase-5-android-native-plate.md)
- [Phase 5 (iOS) — native plate — DONE 2026-09-16](8-execution-log/phase-5-ios-native-plate.md)
- [Phase 6 — spec and docs — DONE 2026-09-16](8-execution-log/phase-6-spec-and-docs.md)
- [Phase 7 — release gate against staging — DONE 2026-09-16](8-execution-log/phase-7-release-gate.md)
