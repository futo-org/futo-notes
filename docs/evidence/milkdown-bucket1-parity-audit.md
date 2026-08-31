# Milkdown bucket‑1 spec parity audit — line by line (T11, issue #108)

**Scope.** The `docs/spec/editor.md` bucket‑1 sections this ticket names — saving & rename,
editor exits, Android IME, theming, cursor/selection, external links, interactive elements
(docs/plan/milkdown-transition.md §4). The other bucket‑1 surfaces were audited by their own
tickets and their evidence stands: wikilinks (T4/#101), tags + checkboxes + fence highlighting
(T5/#102), images (T6/#103), toolbar (T7/#104), progressive open (T8/#105), WebView floor
(T10/#107). Live‑preview/decorated‑source sections are bucket‑2 by decision D6 — renegotiated in
the swap's spec MR, not matched — and are out of scope here.

**Where Milkdown runs today.** The Milkdown editor is the native shells' embedded editor
(`editor.html`, iOS + Android); the desktop app still mounts CodeMirror until the three‑platform
swap (#111). Spec lines tagged `_(desktop)_` therefore audit as **DESKTOP‑CM6** — the shipped
behavior is unchanged by this branch, and the line is re‑audited at the swap.

**Verdicts.**

- **PASS** — the behavior holds under Milkdown, with the evidence cited.
- **FIXED** — a residual surfaced in this audit and was fixed in this ticket, with regression
  coverage at the cited seam.
- **RENEGOTIATE** — the line is CodeMirror‑shaped (it describes the source‑text editing model);
  the WYSIWYG engine meets the line's *intent* a different way, recorded here (and as an inline
  spec Gap where user‑visible) as input for the bucket‑2 spec MR (D9).
- **DESKTOP‑CM6** — a desktop‑tagged line; not a Milkdown surface until #111.
- **GAP** — an already‑recorded spec Gap that stands unchanged; cited, not re‑litigated.

**Evidence keys.**

- `[interactive]` tests/editor-embed-milkdown-interactive.spec.ts — added by this ticket; drives
  the built `editor.html` (the exact bytes both native shells ship).
- `[milkdown]` tests/editor-embed-milkdown.spec.ts, `[parity]`
  tests/editor-embed-milkdown-parity.spec.ts, `[toolbar]`
  tests/editor-embed-milkdown-toolbar.spec.ts, `[wikilinks]`
  tests/editor-embed-milkdown-wikilinks.spec.ts, `[compat]`
  tests/editor-embed-milkdown-compat.spec.ts, `[floor]`
  tests/editor-embed-webview-floor.spec.ts — the existing bundle‑seam suites. Whole
  `test:e2e:editor-embed` run this audit: **259 passed, 0 failed** (exit 0), of which 14 are
  this ticket's `[interactive]` file.
- `[unit]` vitest at the module seam (file named per row).
- `[shell]` the native shells' own test suites (EditorSessionTest.kt / EditorSessionTests.swift,
  NativeMutationOutcome*). The load‑bearing fact for every `[shell]` row is that **this branch
  changes no shell code** — the diff is confined to the editor bundle's TS/Svelte plus tests and
  docs — and the editor reaches these paths only through the bridge, whose contract is unchanged
  (`bridge-spec:check` green). The Android JVM suite (`just test-android-native`) was RUN this
  audit; the iOS Swift suite (`just test-ios-native`) was NOT — it needs macOS, same reason as
  the iOS device leg below. A `[shell]` row therefore means "specified behavior lives in
  unchanged shell code, covered by that shell's own suite", not "re‑measured here".
- `[census]` the measurement `packages/editor/AGENTS.md` mandates for any change under
  `src/milkdown-compat/` — `just milkdown-census --variant baseline` (unpatched upstream preset)
  then `just milkdown-census --diff build/milkdown-census/baseline` — over the **full corpus,
  30,995 notes**, both runs this audit:

  > `vs build/milkdown-census/baseline: 339 flags cleared, 0 newly raised` — exit 0.

  That clears the stated bar ("zero newly-raised flags over ~31k real notes"). The compat set
  now takes `br_loss` 61 → **0**, `html_loss` 61 → **0**, `empty_link_loss` 26 → **0**, and
  `text_loss` 482 → 437. A second, narrower run isolated *this ticket's* serializer handler by
  patching only it out (`--limit 4000`): counters identical with and without it, so the handler
  raises no flag and clears none on its own.
  Note what the census does *not* show: it has no counter for the empty‑cell rewrite, so for
  this ticket it is evidence of **no regression**, not evidence of the fix's benefit — that is
  the unit + bundle‑seam + device coverage below.
- `[device]` the Android pool emulator futo‑qa‑3, claimed by this worktree via
  `just qa-claim android` and driven this run; the oracle is the note file on disk. The iOS leg
  was NOT run — see "Device legs" below.
- `[probe]` behavior measured against the built bundle during this audit via a throwaway
  scratch probe, with the observed values quoted in the row. Not a committed test; rows that
  rest on a probe alone say so.

---

## Theming

| Spec line | Verdict | Evidence |
|---|---|---|
| Editor follows app theme; desktop `data-theme`, native `setTheme` over the bridge | PASS | `[parity]` "token colours come from the theme, and follow it"; `[milkdown]` initialize applies theme; `setTheme` flips `data-theme` `[probe]` |
| Native embed paints no background of its own; both hosts render the WebView transparent | PASS | Page‑level `editor.html` rule, engine‑independent; body background transparent under Milkdown `[probe]`; host halves unchanged |
| Legacy Android unlayered text‑color fallback (Chromium < 99) | PASS | `editor.html`‑level, engine‑independent; `[floor]` legacy‑WebView rewrites cover both engines |
| Chromium 80 floor: `replaceAll` shim, `Array.prototype.at` shim, `textContent` over `replaceChildren` | PASS | Written for Milkdown by T10 (#107); `[floor]` deletes each shim and proves the editor needs it |
| The floor is a property of the built bundle; post‑floor built‑ins shimmed or fail the audit | PASS | `[floor]` bundle audit |
| Engine support decided by capability, never a version number | PASS | T10; EditorEngineSupport.kt preflight tests `[shell]` |
| "Mounted" = the engine came up (`window.__futoEditorMounted`), not the host API | PASS | Line written for Milkdown (T10); src/editor-embed/main.ts; `[floor]` |
| Update‑WebView notice replaces a blank pane; rest of app works; Back needs no save | PASS | Android‑native, engine‑independent; T10 verified; `exitWithoutEditor` `[shell]` |
| Notice names the Chromium major + provider package | PASS | T10 `[shell]` |
| iOS needs no gate | PASS | Deployment floor argument unchanged |
| minSdk 28 | PASS | apps/android/app/build.gradle.kts unchanged |

The recorded Gap (an engine that mounts and then throws inside a later parse shows a blank pane)
stands — GAP, T10's own finding.

## Cursor

### Placement

| Spec line | Verdict | Evidence |
|---|---|---|
| Tapping text places the caret at the tapped character | PASS | ProseMirror/contenteditable‑native; every click‑driven test in `[interactive]`/`[parity]`/`[milkdown]` depends on it; typing verified on the claimed emulator `[device]` |
| Tapping past a row's rendered text lands at the row's end; wrap boundary stays on the tapped row | PASS (native) | Browser‑native WYSIWYG hit testing (`posAtCoords`); no hidden markup exists to mis‑enter. The CM6 wrap‑boundary refinement is engine machinery, not a separate user promise |
| Off‑text placement beside hidden trailing syntax uses the logical line end | GAP → RENEGOTIATE | Already recorded inline: a Milkdown wikilink is an atom whose source never shows; bucket‑2 input (spec "Cursor — Placement" Gap) |
| Arrow up/down moves by visual row and skips block widgets | RENEGOTIATE | Visual‑row movement is native (PASS half). It does NOT skip block widgets: arrowing onto one *selects the node*, and the next character typed replaces it. Measured `[probe]` — in `above\n\n---\n\nbelow`, ArrowDown from `above` yields a `NodeSelection` on `hr` (`empty: false`), and typing `X` yields `above\n\nX\n\nbelow`, i.e. the rule is destroyed. Selecting an atom is the standard ProseMirror idiom for reaching one, so this is bucket‑2 input, not a defect with an obvious fix; **recorded as a new inline spec Gap by this ticket** (spec "Cursor — Placement") because the destructive half is user‑visible |
| Enter in a continued list item scrolls the new item into view (iOS) | PASS (not re‑verified on device) | ProseMirror commands dispatch with `scrollIntoView`; the iOS‑specific keyboard interplay is dogfood (D8) territory |

### Blank editor surface

| Spec line | Verdict | Evidence |
|---|---|---|
| Blank space beside/below lines is part of the editor (desktop press/drag/right‑click) | DESKTOP‑CM6 | `.editor-container` CSS + tests unchanged |
| A tap beside a line lands at its nearest end | PASS (native) | ProseMirror `posAtCoords` resolves to the nearest document position by construction |
| Below‑text taps: pointer column < 2 line‑heights, end‑of‑note beyond | RENEGOTIATE | The 2‑line‑height rule is CM6 pointer machinery. The intent — a tap in the blank tail reaches the note and focuses — holds: `.ProseMirror` is the full‑height scroller and the `trailing` plugin keeps a tappable trailing paragraph; a deep below‑text tap focuses and types at the end `[probe]` |
| Modified presses retain platform selection behavior | PASS | Milkdown's tap handlers claim only links and checkboxes (`consumesTap`); everything else is left native |
| Off‑text double‑tap selects the resolved word; iOS triple‑tap the paragraph | RENEGOTIATE | CM6 off‑text resolution; on‑text multi‑taps are native in the WYSIWYG editor and there is no off‑text zone with hidden syntax to resolve against; bucket‑2 input |
| Tag‑bar blank space reaches the first visible line (desktop) | DESKTOP‑CM6 + GAP | Also suspended by the recorded T5 Gap (the leading tag block is not hidden in Milkdown) |
| Desktop press outside the editor deselects without moving the caret | DESKTOP‑CM6 | NoteWorkspace.svelte unchanged |
| Press into a hidden‑tag‑markup‑only note refused (desktop; native keeps a caret) | GAP | The T5 Gap records this line as suspended under Milkdown: the block is not hidden, so the note is ordinary text |

### Native touch and focus

| Spec line | Verdict | Evidence |
|---|---|---|
| Tapping an unfocused editor places the caret and raises the keyboard | PASS | Native contenteditable focus + the shells' keyboard shims (unchanged); typing on the claimed emulator `[device]` |
| Off‑text placement has one owner and never visibly jumps (mousedown vs touchend split) | RENEGOTIATE | The CM6 `editorPointerInteractions` off‑text machinery does not run in Milkdown; placement is engine‑native, so there is no second owner to race. Bucket‑2 input |
| Android compatibility‑mouse‑event correction of Blink misplacements | RENEGOTIATE | CM6‑on‑Blink workaround; ProseMirror owns its own tap mapping. Emulator typing/caret smoke clean `[device]` |
| iOS blank tail scrollable and outside contenteditable | RENEGOTIATE | Milkdown's `.ProseMirror` is itself the scroller (`overscroll-behavior: contain` kept) and `trailing` guarantees a tappable final paragraph; the CM6 `[data-ios-off-text-surface]` construct has no counterpart |
| First iOS tap focuses with `preventScroll` | RENEGOTIATE | CM6 touchend path; Milkdown focus is engine‑native. iOS keyboard‑presentation jump is a dogfood (D8) watch item |
| Native‑shell policy from `nativeShell` mode | PASS | MilkdownEditor.svelte wires its tap handlers to the `nativeShell` prop |
| Focused on‑text placement native on iOS; Android corrects single taps | RENEGOTIATE | Same class as the Blink‑correction row above |
| On‑text double/triple‑tap selection native on both shells | PASS | Milkdown consumes neither |

### Selection

| Spec line | Verdict | Evidence |
|---|---|---|
| Native shells keep platform selection, handles, loupe, callout | PASS | ProseMirror keeps the native selection; the block‑drag work hardened exactly this on devices (spike hardening, T‑series device rounds) |
| Desktop drag‑selection expands through hidden source markers | DESKTOP‑CM6 | selectionSnap.ts unchanged |

## External links

| Spec line | Verdict | Evidence |
|---|---|---|
| Tap opens the system browser via the `openUrl` bridge (touchend path, scheme‑guarded hosts) | PASS | `[milkdown]` "tapping an external link posts openUrl and never calls window.open"; host‑side guards + `EditorNavigationDecisionTests` unchanged `[shell]` |
| Only the link's own glyphs open it; blank space past the link places the caret | PASS (locked this run) | `[interactive]` "clicking blank space past a link places the caret instead of opening it" — structural in Milkdown: the link is a real `<a>`, so its hit area IS its glyphs |

## Interactive elements

| Spec line | Verdict | Evidence |
|---|---|---|
| Tapping a task checkbox toggles `[ ]`/`[x]` and autosaves, no cursor placement | PASS | `[parity]` full checkbox section (tap w/o focus, tap target size, one‑undo‑step, others untouched) |
| Table cells individually editable in place | PASS (locked this run) | `[interactive]` "a table cell is editable in place"; structural PM tables |
| Tab / Shift+Tab move between cells | PASS (locked this run) | `[interactive]`; preset `goToNextCell`. Tab at the very last cell **FIXED**: it appended nothing and dropped focus (typed characters vanished); now appends a row like CM6's wrap‑around — src/features/editor/milkdown/keyboardParity.ts `[unit]` + `[interactive]` |
| Enter inserts a new row below the current one (last row appends) | **FIXED** | The gfm preset bound bare Enter to `exitTable` (leave the table + stray empty paragraph), so a phone user could not add a row at all. Now: row below, caret in the same column; header row inserts the first body row; Mod‑Enter keeps `exitTable`. keyboardParity.ts `[unit]` ×14 + `[interactive]` ×4. Empty cells also **FIXED** to serialize as `` `|  |` `` rather than `` `| <br /> |` `` (see milkdown‑compat/emptyLine.ts `htmlWithoutEmptyCellPlaceholder`; `[census]` 0 flags moved) — before this, ANY note holding an empty cell had it rewritten to `<br />` by the first unrelated keystroke |
| Structure revalidated on each edit | PASS | PM structural tables make invalid table shapes unrepresentable; serializer emits a well‑formed GFM table every time `[interactive]` |
| Cell context menu (desktop right‑click) inserts/deletes rows/columns | DESKTOP‑CM6 | tableEditorWidget unchanged on desktop |
| Enter continues a list (inherits nesting, auto numbers) | PASS (locked this run) | `[interactive]` bullet/ordered/nested continuation |
| Backspace at item start dedents | PASS w/ note | The item loses its marker (ProseMirror `liftListItem`); the resulting markdown parks the text as a continuation paragraph rather than CM6's plain line — same intent, different bytes; noted for the bucket‑2 MR `[probe]` |
| Backspace in an empty item deletes it | PASS | `[probe]`; Enter on an empty item also leaves the list `[interactive]` |
| New task item from a split starts unchecked | **FIXED** | `splitListItem` cloned `checked: true` onto the new item (`- [x]` babies); now the split resets it, matching CM6's `listContinuation`, which inserts a literal `[ ] ` and discards the current item's state (src/features/editor/listContinuation.ts — the `[ xX]` capture group is deliberately unused). keyboardParity.ts `splitCheckedTaskItem` `[unit]` + `[interactive]` ×2, and on the emulator `[device]`: `- [x] done` + Enter + "next" wrote `- [x] done\n- [ ] next` to disk. The behavior was UNSPECIFIED — true of CM6 but never written down — so this ticket also **adds the spec line** to "Interactive elements" rather than leaving a fixed behavior unrecorded (M19) |
| Undo of an edit that renumbered reverses both as one step | RENEGOTIATE | Numbering is document structure in WYSIWYG — there is no separate renumber transaction to group; undo reverses the edit, the serializer emits the list's numbering. ADR‑0002 |
| Opening a note leaves its numbering exactly as written | PASS | `[milkdown]` "opening X returns the host's own bytes and posts no change"; the load‑echo guard means a lazily numbered `1./1./1.` list keeps its bytes on disk until a real edit. On screen the numbers display normalized (the list is an `<ol>`), which is exactly what the EXISTING native‑shells Gap on this line already records ("opening a note delivers its text as an edit … so a lazily‑numbered note renumbers on screen straight away. Nothing is posted back to the host"). Cited, not re‑litigated — no spec change needed |
| External text adopted exactly as sent (no renumber, no echo) | PASS | `[milkdown]` applyExternalContent tests |
| Undo only reverses edits made in the open note; opening is not undoable | PASS | `[milkdown]` boot‑config/undo tests; streamed appends not undoable |
| Per‑note undo/redo while the app runs | GAP | The recorded native‑shells Gap stands (shells don't tell the editor which note); `[milkdown]` locks the safe half ("a host note switch clears undo even when the next note has identical text") |
| A note edited elsewhere comes back without undo history | PASS | Same mechanism/tests |
| An outside change is not undoable and cannot revive the superseded version | PASS | `[milkdown]` applyExternalContent + undo tests |
| Deleting a note discards undo; rename/move keeps it | PASS / DESKTOP‑CM6 | Desktop noteHistory unchanged; on the native shells note switches clear the WebView history (Gap above) |
| Desktop single‑line selection toolbar | DESKTOP‑CM6 | selectionToolbar.ts unchanged |
| `/` block‑command menu (desktop) | DESKTOP‑CM6 | slashMenu.ts is wired only in createMarkdownEditorRuntime (CM6) |

## Saving & rename

The engine's whole contribution to this section is the change/capture contract, and it is tested
against Milkdown directly: a real keystroke posts exactly one change carrying the normalized
document; a host `setContent`/boot note posts no change (the load‑echo guard, ADR‑0002's
reference behavior); `getContent` returns the host's own bytes while clean; and no change can
fire while a progressive open streams (the save lock, T8). `[milkdown]` covers all four.
Everything else in the section is shell/engine‑side code the editor swap does not touch.

| Spec line | Verdict | Evidence |
|---|---|---|
| Body autosave debounce; save re‑reads the id at fire time | PASS | `[shell]` scheduleSave; bridge change contract `[milkdown]` |
| Explicit committed/failed save outcomes; failed writes keep the draft dirty; identity mutations vs retained drafts | PASS | `[shell]` NativeMutationOutcome tests (Android JVM suite run this audit; iOS suite per evidence note below) |
| Title debounce → rename; body flushed to the current id first | PASS | `[shell]` commitRename |
| Leaving the editor flushes only if content changed | PASS | Load‑echo guard `[milkdown]` + `[shell]` |
| Delete is the final mutation; session serialization; iOS quarantine/cover rules | PASS | `[shell]` EditorSession suites |
| Backgrounding best‑effort flush | PASS | `[shell]` |
| `flush_draft` one‑verb dispositions (wrote/converged/recreated/parked) | PASS | Rust store tests + FFI contract + both shells' suites — engine‑independent |
| Durable flush always advances the saved baseline | PASS | `[shell]` SettledFlushTests / NonCancellable span |
| Draft register derived, owner‑scoped | PASS | `[shell]` |
| Empty title → "Untitled"; title strips newlines | PASS | Native title fields, outside the WebView |
| Whitespace‑only title difference skips the write | PASS | `[shell]` |
| Duplicate title blocks the save with the inline warning | PASS | `[shell]` |
| No word count in editor chrome | PASS | Unchanged |
| Tauri title contract (10 s debounce, blur/Enter commits, pointer‑gesture deferral) | DESKTOP‑CM6 | noteSession/createNoteTitleController unchanged |

## Editor exits _(iOS/Android)_

Every line in this section is shell code (EditorSession.kt / EditorSession.swift) reached through
the same bridge either engine serves: the exits' capture is the `getContent` round trip, and
change fencing rides the same change messages. The section's wording says "the latest live CM6
body" — under Milkdown the capture is the same bridge call against the WYSIWYG engine; the
bucket‑2 spec MR should reword "CM6" to "editor". Ordering, latches, drains, refusals, and both
recorded divergence Gaps (#79 iOS parked‑conflict on navigation, #80 Android dropped quarantine)
are exactly as recorded — PASS via `[shell]` ordering suites, gaps stand.

| Spec line group | Verdict | Evidence |
|---|---|---|
| Latches before first suspension; destructive cancels before drain; exact‑snapshot commit; refusal semantics; one‑way delete latch; single admitted exit; effect/workflow non‑interleave; change fencing; external‑delete close; detached exits (legacy notice) | PASS | `[shell]` EditorSessionTest.kt / EditorSessionTests.swift, NativeMutationOutcome*; bridge contract `[milkdown]` |
| Three permitted divergences (commit order, capture source, move‑picker timing) | PASS | As specified, unchanged |
| Gap #79 (iOS parked‑conflict on navigation) / Gap #80 (Android drops the post‑latch change) | GAP | Stand; shell behavior, not Milkdown's |

## Android — IME

| Spec line | Verdict | Evidence |
|---|---|---|
| Backspace on an empty note must not crash the renderer | PASS | Resolved upstream (FUTO Keyboard fix, recorded history); backspace‑on‑empty exercised against the Milkdown bundle `[interactive]` (empty‑item deletes) and on the claimed emulator `[device]` |
| Typing free of IME/caret glitches on every WebView | PASS on the modern tier + GAP | Emulator typing smoke clean under Milkdown `[device]`; the recorded github#8 old‑WebView‑tier Gap stands; per decision D8 there is deliberately no formal keyboard matrix — the dogfood period (#110) is the IME exposure |

---

## Residual fixes landed by this ticket

1. **Enter in a table cell inserts a row below** (last row appends; header row inserts the first
   body row; caret follows to the same column). Was: `exitTable` + a stray paragraph; on the
   native shells there was NO way to add a row. src/features/editor/milkdown/keyboardParity.ts,
   wired as the `handleKeyDown` direct view prop.
2. **Tab at the very last cell appends a row** instead of tabbing focus out of the editor and
   swallowing subsequent typing.
3. **Splitting a checked task item starts the new item unchecked** (CM6 `listContinuation`
   parity; the default split cloned `checked: true`).
4. **An empty table cell serializes as `|  |`**, not `| <br /> |`
   (packages/editor/src/milkdown-compat/emptyLine.ts `htmlWithoutEmptyCellPlaceholder`). Also
   repairs a pre‑existing corruption: any note holding an empty cell had it rewritten to
   `| <br /> |` by the first unrelated keystroke. Full-corpus census `--diff`: 339 cleared,
   **0 newly raised** over 30,995 notes. It replaces the stock remark‑stringify `html` handler,
   which is exactly `node.value || ''` with `peek() === '<'` — verified against
   `mdast-util-to-markdown/lib/handle/html.js`, and nothing in Milkdown or this repo installs a
   custom one — so everything the handler does not claim serializes identically.
5. **Flake hardening**: the formatState bold assertion now polls for the settled state instead of
   reading the first message after a click (tests/editor-embed-milkdown.spec.ts).

Regression coverage: 14 unit tests (keyboardParity.test.ts), 5 handler tests
(emptyLine.test.ts), 14 bundle‑seam tests (editor-embed-milkdown-interactive.spec.ts).

**Red‑proof (the coverage is load‑bearing, not decorative).** Each fix was patched back out of
`MilkdownEditor.svelte` and the bundle‑seam suite re‑run against the rebuilt bundle, so the
tests are known to fail for the stated reason rather than passing vacuously (AGENTS.md 7.9):

| Bundle state | Result |
|---|---|
| Both fixes present | 14 passed |
| Both fixes removed | **6 failed**, 8 passed |
| `handleKeyDown` restored, serializer handler still out | **5 failed**, 9 passed |

The third row is the one that matters for the serializer fix: it fails independently of the
keyboard fix, because the empty cell in the newly appended row serializes as `| <br /> |`
without the handler. The 8 tests that stay green in row 2 are the ones marked "PASS (locked
this run)" — they lock pre‑existing behavior, so staying green with the fixes removed is the
correct outcome for them.

## Device legs (hardware note)

The ticket asks for all three shells. What was actually run, and what was not:

- **Desktop — N/A, structurally.** No desktop surface mounts Milkdown on this branch:
  `MilkdownEditor.svelte` is imported only by `src/editor-embed/main.ts` (verified by grep over
  `src/`), and the desktop app mounts `MarkdownEditor.svelte` (CM6) until the swap (#111). So
  there is no Milkdown desktop behavior to audit, and every `DESKTOP‑CM6` verdict above means
  "shipped behavior unchanged by this branch, re‑audit at #111" — not "assumed to pass".
- **Android — RUN, and the fixes are proven end to end.** Pool emulator futo‑qa‑3 (claimed by
  this worktree via `just qa-claim android`; `$ANDROID_SERIAL` pinned to `emulator-5554` so the
  physical phone also attached to this machine was never touched). The dev app
  (`com.futo.notes.dev`) was built and installed from this branch, and the staged
  `apps/android/app/src/main/assets/editor.html` was confirmed byte‑identical (sha256) to a
  fresh build of the working tree, so the APK really carries the code under audit. Driven with
  a seeded table + task note, using OS‑level key input through the real soft keyboard, with the
  note file on disk as the oracle:
  - Enter in the last table row appended a row — the file gained `| phone |     |`. This is the
    fix whose absence meant a phone user could not add a table row at all.
  - The appended empty cell serialized as `|     |`, not `| <br /> |` — the serializer fix,
    confirmed on a real WebView rather than only in Chromium.
  - `- [x] done` + Enter + "next" wrote `- [x] done\n- [ ] next` — the unchecked‑split fix.
  Screenshots: the table and checkbox render as real interactive elements under Milkdown.
- **Android IME — partially run, and one attempt discarded as tool noise.** The typing above
  went through the emulator's real soft keyboard, which is genuine IME exposure for the fixed
  paths. A separate backspace‑on‑empty‑note probe was ABANDONED, not recorded: driving it by raw
  `adb shell input tap` coordinates with the keyboard up picked up the suggestion strip and
  inserted junk ("to" ×13) while deleting a header cell. That is the M21 trap, so the
  backspace‑on‑empty spec line rests on its documented upstream resolution and the bundle‑seam
  coverage, NOT on a device result from this run. No spec gap is recorded from it.
- **iOS — NOT RUN.** This machine is Linux (`xcrun`/`xcodebuild` absent), so the leg needs the
  Mac over Tailscale. Two attempts were made and both were blocked; the findings, so the next
  run does not repeat them:
  1. The Mac IS reachable (macOS 26.6.1) and HAS booted simulators, including pool devices
     `futo-qa-1`/`futo-qa-2` — so the device side is fine.
  2. But `~/Developer/futo-notes` there is **not a git repository** (`git fetch` → "fatal: not a
     git repository"), `xcodegen` is **not installed** (`which xcodegen` → not found), and there
     is no prebuilt `apps/ios/Frameworks` xcframework. So the leg needs a fresh clone plus a
     `brew install xcodegen` plus a cold `build-rust-ios` — installing toolchain on the user's
     machine, which this run did not do on its own authority.
  This is **not** claimed as evidence anywhere above.
  What stands in for it, and what does not: the iOS shell loads the SAME single‑file
  `editor.html` bytes as Android (`vite.editor.config.ts` stages one artifact into both), and
  the fixes are engine‑internal ProseMirror/remark logic in that bundle, exercised by 14
  bundle‑seam tests against those exact bytes. That is a strong argument, not a measurement:
  the untested iOS‑specific surface is WKWebView keydown delivery for Enter/Tab (hardware and
  software keyboard) and iOS text‑interaction gestures. **Recommended before #111: run
  `just test-ios-native` + a table/task smoke on a claimed simulator.** What a simulator cannot
  prove regardless (jetsam, real‑keyboard IME) remains dogfood (#110).
