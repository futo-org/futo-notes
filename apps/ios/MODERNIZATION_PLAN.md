# Native iOS — Modernization & Liquid Glass Plan

> Status: **planned, not started.** Authored from a review of `apps/ios/Sources/*`
> + `project.yml` against the `swiftui-expert-skill`, `swift-concurrency-pro`,
> and `swift-testing-pro` skills. Execute workstreams in order A → B → C → D → E
> (D runs in parallel). Verification is per-workstream below.

## Locked decisions

1. **Keep the iOS 18.0 deployment floor.** All Liquid Glass (iOS 26+) APIs ship
   behind `#available(iOS 26, *)` with a `.ultraThinMaterial` fallback. Do NOT
   raise the minimum.
2. **The `@Observable` migration (Workstream B) is in scope** and happens
   alongside the rest of this work — not deferred. The four model classes are
   already `@MainActor` + single-writer, so the migration is low-risk.

## Baseline assessment

The app is well-engineered, not a rough spike. Already correct: off-main FS I/O
via actors (`NoteVault`, `SearchService`), the "never gate render on I/O" boot
(`NotesStore.init:228`, `bootstrap:247`), single-source note rules in Rust, and
real data-loss guards (debounced save with re-read-id-at-fire
`NoteEditorView:183`; ghost-note fixes on rename/move/delete; scenePhase flush
`FutoNotesApp:65`; 3-way conflict-copy `adoptExternalChange:244`;
WebContent-process-terminate recovery `EditorWebView:375`). This plan is
modernization + hardening, not rescue.

---

## Workstream A — Build & concurrency foundation (highest leverage)

The code is written *as if* for Swift 6 (actors, `@MainActor`,
`nonisolated(unsafe)` globals) but compiled in Swift 5 mode with minimal
concurrency checking (`project.yml:13-14`), discarding the checking it was
structured to pass.

- [ ] **`SWIFT_VERSION` 5.0 → 6.0** and **`SWIFT_STRICT_CONCURRENCY` minimal →
  complete** (`project.yml:13-14`). Isolation is already explicit, so expect few
  real diagnostics — fix any that surface, then it's locked in.
- [ ] **Adopt Swift 6.2 default main-actor isolation**
  (`SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`). App is almost all UI/lifecycle
  code → delete most explicit `@MainActor`, leaving `NoteVault` /
  `SearchService` as the visible off-main exceptions. Networking/FFI stay
  off-main (this setting does not move them onto main).
- [ ] **`FutoAssetSchemeHandler`** (`EditorImages.swift:29`): un-isolated but
  mutates `stopped: Set` across GCD hops. Callbacks are main-thread in practice
  → mark `@MainActor` (or move the set into an actor) so it's provable.
- [ ] **`SearchService` ordering** (`SearchService.swift:69-83`): fire-and-forget
  `Task {}` per mutation has no ordering guarantee — `noteChanged` then
  `noteRemoved` can reorder and leave the index stale. Serialize through one
  ordered queue / `AsyncStream` feeding the actor.
- [ ] **Jetsam flush hardening (data-loss, F8):** wrap `flushPendingEditor` /
  `flushAsync` (`NotesStore.swift:365`, `FutoNotesApp.swift:77-82`) in a
  `UIApplication.beginBackgroundTask` assertion so iOS grants time for the disk
  write before suspend.

**Verify:** `apps/ios/run.sh` (or XcodeBuildMCP `build_sim`) compiles clean on
the iOS 18 floor with no concurrency warnings.

---

## Workstream B — State management (`@Observable`, iOS 17+)

App targets iOS 18 but uses the pre-17 `ObservableObject` / `@Published` /
`@EnvironmentObject` stack throughout (`NotesStore:151`, `SyncManager:8`,
`CrashReporter:54`, `EditorToolbarState:7`).

- [ ] **Migrate all four model classes to `@Observable`.** Views move from
  `@EnvironmentObject` → `@Environment(Type.self)`; ownership moves to `@State`
  in `FutoNotesApp` (`@StateObject` → `@State`). Payoff: views invalidate only
  on properties they actually read.
  - Note: any `@AppStorage` that ends up inside an `@Observable` class must be
    annotated `@ObservationIgnored` (macro conflict). Currently `@AppStorage`
    lives in views, so this only matters if state is consolidated.
- [ ] **Fix the per-keystroke note-universe re-push (real perf bug).**
  `NoteEditorView.onReceive(store.$notes)` (`:156`) fires on every autosave
  (each save replaces `notes[idx]`), rebuilds the universe JSON *including
  `modifiedMs`* (`:291`) which changes every save → defeats `EditorHost`'s
  dedup (`EditorWebView.swift:252`) → `setNotes(...)` is re-`evaluateJavaScript`'d
  into the WebView on every keystroke-save. Fix: exclude `modifiedMs` from the
  dedup signature (or debounce the universe push), and replace the Combine
  `onReceive` with `onChange(of:)` over a narrowed signal once on `@Observable`.

**Verify:** build_sim; manual typing in a note shows no repeated `setNotes`
bridge calls (Web Inspector). Behavior parity for wikilink autocomplete.

---

## Workstream C — SwiftUI papercuts & modern APIs

| Finding | Location | Change |
|---|---|---|
| `ForEach(Array(groups.enumerated()), id: \.offset)` — offset-as-identity (benign, static array, but flagged) | `EditorToolbar.swift:32` | stable id; drop `Array(...)` (unneeded on Swift 6.1+) |
| Hand-rolled empty / no-match `VStack`s | `NoteListView.swift:143-151, 365-376` | `ContentUnavailableView` / `ContentUnavailableView.search(text:)` (iOS 17+, auto-localized) |
| `Task.sleep(nanoseconds:)` | `NoteEditorView.swift:186` | `Task.sleep(for: .milliseconds(400))` |
| No haptics on create/delete/move | list/editor actions | `.sensoryFeedback(_:trigger:)` (iOS 17+) |
| Decorative SF Symbols not hidden from VoiceOver; rows not combined | empty states, `NoteRow:507` | `.accessibilityHidden(true)` / `.accessibilityElement(children: .combine)` |
| UI strings are literals; no String Catalog | everywhere | add a `Localizable` String Catalog before GA |

**Verify:** build_sim + simulator screenshot spot-check; VoiceOver pass on the
list + editor.

---

## Workstream D — Tests (currently ZERO; runs in parallel)

No test target exists in `apps/ios` — yet `AGENTS.md` mandates tests for logic
changes. Add a **Swift Testing** target (`struct` suites, `#expect`/`#require`,
parameterized; never XCTest) covering:

- [ ] **Conflict resolution** — `adoptExternalChange` clean / dirty / converged /
  true-3-way branches (pure logic, high value, untested).
- [ ] **Path-traversal guard** — `FutoAssetSchemeHandler` rejects `../`, nested
  `/`, and non-image extensions (security-relevant).
- [ ] **`VaultImages`** — filename uniqueness + `mimeType` mapping vs the shared
  image-extension set.
- [ ] **`Keychain`** — round-trip + dev/prod service separation
  (`com.futo.notes.dev.sync` vs `com.futo.notes.sync`).
- [ ] **`NoteVault`** — seeding / CRUD / relink through the Rust core
  (integration).

Add the test target to `project.yml` (`type: bundle.unit-test`) and run via
`test_sim`.

---

## Workstream E — Liquid Glass version (iOS 26+, gated to the iOS 18 floor)

Two tracks, because most of the app is system chrome and the floor stays at 18.

### Track 1 — "free" glass from system components (build against iOS 26 SDK)
`NavigationStack`, `List`/`Form`, `.searchable`, `.toolbar`, `.sheet`, and
`confirmationDialog` adopt Liquid Glass automatically on iOS 26. The list,
Settings, Sync, Move, and Crash sheets get glass nav bars, sheet glass, and the
automatic scroll-edge effect with **no code**.

- [ ] **Prereq cleanup:** the custom `listRowBackground(Theme.surface)` +
  `scrollContentBackground(.hidden)` and the per-bar `Theme.background` /
  `Theme.surface` painting fight the scroll-edge effect (the skill explicitly
  warns against darkening behind bars). Gate those off on iOS 26 and let system
  materials render.

### Track 2 — custom surfaces (explicit `glassEffect`, `#available`-gated + material fallback)
- [ ] **Editor keyboard toolbar (centerpiece)** — `EditorToolbar.swift` /
  `EditorToolbarAccessory`. Today: opaque `Theme.surface` `inputAccessoryView`
  with hand-drawn hairline separators. Convert: keep the
  `UIHostingController`-in-`inputAccessoryView` hosting, wrap button groups in
  `GlassEffectContainer`, buttons get `.glassEffect(.regular.interactive(), in:
  .capsule)`, drop the opaque background + hairlines so it floats as glass over
  the editor, monochrome icons (tint only to convey meaning). Fallback
  `.ultraThinMaterial` for < iOS 26.
- [ ] **SYNCED/LOCAL badge + account header** (`SettingsView.swift:148-180`) →
  capsule glass.
- [ ] **Create / sync / settings affordances** → `.buttonStyle(.glass)`; add
  `.searchToolbarBehavior(.minimizable)` on the search field.
- [ ] **Sheet entry** (new note, move) → `navigationTransitionSource` / zoom
  transition.

### Editor cohesion (good news)
The WebView is already `isOpaque = false` with a clear background
(`EditorWebView.swift:149-151`). So the native glass nav bar (above) and glass
keyboard toolbar (below) show through cohesively — and making the editor.html
surface transparent makes the editor read as one continuous glass-framed canvas
rather than a boxed webview. The CodeMirror content itself can't be "glass" (web
content); glass applies to the native frame around it.

### Deliverable
- [ ] A reusable `glassEffectWithFallback(_:in:fallbackMaterial:)` `@ViewBuilder`
  (per the liquid-glass skill reference), with all custom glass behind
  `#available(iOS 26, *)`.

**Verify:** build_sim on the iOS 18 floor (confirms it compiles + falls back),
then screenshot on an **iOS 26 simulator** to confirm glass.

---

## Verification summary

Native iOS is **not** covered by `just build` (that's web/Tauri). For this work:
- Compile + fall back: `apps/ios/run.sh` / XcodeBuildMCP `build_sim` on iOS 18.
- New tests: `test_sim` against the Swift Testing target.
- Glass visuals: screenshot on an iOS 26 simulator.
