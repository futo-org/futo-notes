# Plan: iOS autosave conflict-copy regression — fix, device stories, pre-push gate

Status: implemented and locally verified on `fix/ios-autosave-baseline-cancellation`; landing pending.
Owner: Justin. Written 2026-08-21, after the live diagnosis session on TestFlight v1.7.0.

## Incident summary

Typing into one note on the native iOS app at ~2.5 characters/second mints
`<title> (conflict YYYY-MM-DD)` copies — 9 copies of one note in ~3 minutes on a
pooled simulator, first copy within ~20 s. The editor silently rebinds to each copy,
so the original note stops receiving edits. Sync is **not** involved (reproduced with
sync disconnected); the `:stable` server is incidental.

Root cause: commit `6dfcf14bd` ("feat(ios): render open-note dispositions", first
shipped in v1.7.0) moved the debounced autosave from `store.write` +
`confirmedSavedContent` onto `store.flushDraft`, and put the baseline advance
(`savedContent = newContent`) behind `guard session.isActive` — i.e. behind
`Task.isCancelled`. Every keystroke's `session.schedule(.save)` cancels the in-flight
save task, but a flush that has already returned is **durable**: skipping the record
leaves `savedContent` behind disk, so the next flush's `base` is stale and the engine
correctly parks the editor's own earlier write as a conflict copy
(`crates/futo-notes-store/src/lib.rs` `flush_draft`, diverged arm). Android is immune:
its equivalent span runs under `withContext(NonCancellable)`
(`apps/android/app/src/main/java/com/futo/notes/ui/EditorSession.kt`).

Why no test caught it: the decision lived in a tested pure function
(`confirmedSavedContent`) until `6dfcf14bd` inlined it into the SwiftUI view, where no
seam reaches it; `FlushDraftVerbTests` pins the engine's park (correct behavior, wrong
layer to catch this); `EditorSessionTests` pins that a cancelled save *settles* but its
fake body has no baseline to go stale; nothing on any platform types at a human cadence
or asserts "no files the user didn't create".

## Invariant being installed

**A durable flush always advances the editor's baseline. Only identity may veto the
record — never task liveness.** Everything below either implements, tests, or gates
that sentence.

## Phase 1 — the fix (mostly done, needs landing)

Already coded and green on the branch (`just test-ios-native`, "Settled flush" suite):

- `apps/ios/Sources/Notes/Storage/NotesStore.swift`: new pure `settledFlush(...)` →
  `SettledFlush { record / follow / ignore }`. Takes **no liveness input** — its
  signature is the fix. Vetoes only on `currentId != flushedId`; a park during a
  latched destructive exit records bytes without rebinding identity
  (`sessionIsClosing`).
- `apps/ios/Sources/Notes/Editor/NoteEditorView.swift` `scheduleSave`: flush result now
  routes through `settledFlush`; the cancellation guard between flush and record is
  gone, with a comment explaining why its absence is deliberate. The `follow` arm
  advances the baseline *and* rebinds — without that, the editor sits on the copy with
  a base describing the original and re-parks on every save (how 1 copy became 9).
- `apps/ios/Tests/Notes/Editor/SettledFlushTests.swift`: 8-case truth table, including
  "following a park never leaves the baseline behind the copy on disk" and the
  closing-exit arm.
- `apps/ios/Tests/Notes/Editor/EditorSessionTests.swift` `cancelledSaveStillResumes`:
  pins the session property that made the bug possible — a cancelled save's body
  resumes past its suspension with `Task.isCancelled == true`, so its write is already
  durable.

Remaining to land:

1. **Spec (M19)**: add the invariant to `docs/spec/editor.md`'s flush/park section —
   durable flush always advances the shell baseline; the next keystroke's reschedule
   must never skip the record; name `settledFlush` (iOS), `NonCancellable` (Android),
   and the guarding tests. No new Gap note (behavior now matches intent).
   the `> **Gap:**` notes in `docs/spec/` stay accurate.
2. **Drift registry**: append this incident to the `editor-exit-ordering` entry's
   note — a divergence between the two `EditorSession`s shipped as a device bug,
   which is the escalation trigger the entry itself names. Decision on acting on it
   is an open question (below), recording it is not.
3. **Commit** per §5 conventions: `fix(ios): record a durable autosave flush even when
   its task was cancelled`, body naming the failure (v1.7.0 TestFlight conflict-copy
   storm while typing), the root-cause commit, and `Verified:` lines. Branch + MR
   (data-shaped fix → not direct to main).
4. MR description carries the Android-parity statement the drift entry requires when
   one shell's ordering changes: Android already holds the invariant; no Kotlin change.

## Phase 2 — iOS story harness + the regression story + vault invariant

The device-level test that fails on `main` and passes with the fix (§7.9 discharged at
the layer the bug lives in). Mirrors `tests/lib/android/` in shape; ~all new code.

<!-- check-agent-docs: ignore-next-block -->
```
tests/lib/ios/axeClient.mjs        exec wrapper: AXe by explicit UDID + xcrun simctl
                                   (container path, screenshot, launch/terminate)
tests/lib/ios/device.mjs           waitFor (condition-polling, M15), typeText with an
                                   explicit inter-key gap, tap-by-label, vault access
tests/lib/vaultInvariant.mjs       PURE core: (before, after, expectedCreations) →
                                   violations; flags any unexpected file, and anything
                                   matching the conflict-copy shape by name
tests/lib/vaultInvariant.test.mjs  vitest unit tests (auto-included: tests/lib/**)
tests/ios-editor-stories.mjs       story runner, check() convention from
                                   tests/android-storage-migration.mjs
```

Design decisions:

- **Reuse `scripts/describe-ios-ui.mjs`** (`summarizeAccessibilityTree`, `filterRows`)
  for tree reads — it already owns the off-screen-tap and window-stack-order traps
  (M21); do not grow a second parser.
- **Explicit simulator only**: the harness refuses to run without `$SIM` from
  `just qa-claim ios`. Never the booted-default — parallel worktrees share this
  machine, and typing into an unclaimed simulator is the sim-pool analogue of M24.
- **Story 1 — sustained typing**: seed one note, focus the body, send ~45 single
  HID keystrokes with a ~390 ms inter-key gap (one-character AXe HID input plus an
  explicit settle interval lands keystrokes inside the in-flight flush). Oracle is the
  vault, not the UI: exactly the seeded note afterwards, its bytes = seed + typed
  characters (the canonical hidden `.txt-migration-done` bootstrap sentinel is
  allowlisted separately; no extra files, no lost keys). Polarity matters: on the fixed build the
  invariant is timing-independent, so the story passes deterministically; on a broken
  build the race fires with high probability (measured: first-run hit, every run hit).
- **Vault invariant everywhere**: end-of-story assertion via the shared pure core;
  retrofit onto `tests/android-storage-migration.mjs` checks in the same MR (adapter
  supplies listings over adb; the core is platform-blind).
- New recipe `test-ios-stories`: build + install via the `ios-native` path (a story
  must test the code being pushed, so the build is not skippable), then run the runner.

One-time fail-on-main proof, recorded in the MR: build `main`, run the story, expect
the conflict-copy failure; rebuild the branch, expect green.

## Phase 3 — run it locally before every push

The macscript CI runner is contested; this machine is fast and available. So the gate
is local, path-scoped, and loud about skipping — never silently green (M11 spirit).

- **`.githooks/pre-push`** (hooks path is already `.githooks`; pre-commit establishes
  the mechanism). Reads the ref updates from stdin, diffs local against the remote sha,
  and triggers only when the push touches `apps/ios/`, `packages/editor/`, or
  `crates/futo-notes-{core,store,ffi}/`. Then: require darwin + xcodebuild, claim the
  pooled simulator, run the recipe. Budget on this machine: warm Swift-only rebuild
  ~40–90 s + story ~60 s.
- **Degrade loudly, never mask**: no Mac toolchain / no simulator → print a SKIPPED
  banner naming what was not run. Manual escape hatch `FUTO_SKIP_IOS_STORIES=1`, also
  printed. A hook that cannot run is a visible boundary, not a pass.
- Wire the same recipe into `just prepush` (already the "environment-dependent maximal
  chain") behind the same darwin guard.
- Gates to keep green in the same commit: `just check-agent-docs` (new recipe named
  in docs), `just check-drift`, `just check-qa-input-safety` (the harness drives an
  explicitly addressed simulator, which is the sanctioned pattern).
- **CI stance**: deferred, deliberately. If it ever moves to CI: nightly on macscript
  first, and the moment it becomes required it enters `release:gate.needs` in the same
  commit (M14).

## Phase 4 — deferred follow-ups (each its own MR)

1. **iOS debug test hook** mirroring Android's
   `apps/android/app/src/debug/java/com/futo/notes/testhook/TestHookProtocol.kt`, so
   stories can ask the app for state (~100 ms) instead of reading the a11y tree (~2 s).
   Not needed by story 1 (disk oracle suffices); build it when a story needs app-internal
   state, not before.
2. More stories on the harness: rename-while-typing, background-flush (F8), park-then-
   continue-typing convergence.
3. **Open decision for Justin**: the `editor-exit-ordering` drift entry pre-registered
   its own escalation — "if a third divergence ships as a device bug, the next step is
   the deferred Rust editor engine (crates/futo-notes-editor), not a bigger fixture."
   This incident qualifies. Whether to start that engine is a scope call this plan only
   surfaces.

## Verification matrix

| Change | Chain |
| --- | --- |
| Phase 1 Swift fix + tests | `just test-ios-native` (green on branch), device story from phase 2, spec gap notes re-read |
| Phase 2 harness + story | vitest unit tests for the pure core, fail-on-main proof, story green on branch, Android storage suite still green on a claimed emulator |
| Phase 3 hook + recipes | push dry-run with and without iOS-touching changes; skip banner verified on a non-triggering push; `pnpm exec vitest run scripts/pre-push.test.mjs` |
| Before merge (§7.10) | `just check`; `just prepush` for the final stack |

### Local implementation record — 2026-08-21

- The one-time polarity proof used local `main` at `7b6d7c7a1`: the story failed
  in 25 seconds and found six `Autosave cadence (conflict 2026-08-21…).md`
  copies. Rebuilding this branch made the identical story pass in 26 seconds
  with one note and all 45 typed characters.
- `just test-ios-native` passed 100 Swift tests in 17 suites plus the UI launch
  test; `just test-ios-stories` passed 1/1 after its mandatory rebuild/install.
- The retrofitted Android storage suite passed 6/6 on pooled emulator
  `futo-qa-3`; the shared vault invariant's focused Vitest/routing suite passed
  36 tests.
- `just check` passed. The maximal `just prepush` result is recorded in the MR
  description because it includes environment-dependent device and sync legs.

## Rollback

Phase 1 is a small, self-contained Swift diff — revert restores the (broken) guard.
Phases 2–3 are additive test/tooling surface; removing the hook file disables the gate
without touching product code. Cleanup after the work: `just qa-release --shutdown`
and `just qa-server-stop` for the pooled sim + per-slot server claimed today.
