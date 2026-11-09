# Android text-first handoff: What Android must adopt, and Kotlin→Rust migration

[← handoff index](README.md)

## 5. Android must adopt

The engine half of every item below is already on the branch (`dbe0c2a92`). What remains is
the Kotlin half and the device checks, listed per item.

### 5.1 Indent/Outdent visible everywhere, greyed where they don't apply

- **Spec:** `docs/spec/editor/markdown-toolbar/toolbar-commands.md:5` and `:89`;
  `portable-core/list-indent.md:4-5`; `portable-core/remaining-work.md:17-20` (main);
  `mobile/toolbar.md:4` (branch).
- **State:** the text-first toolbar already shows them everywhere.
  `TextFirstToolbar.kt:49` passes `inContainer = true`, and iOS does the same. Greying already
  reads the engine: `EditorEngineCaret.kt:26-27` adds `indent`/`outdent` to `disabled` from
  `ToolbarState.canIndent/canOutdent`, which now follows !599/!604. No Kotlin change is
  expected; it still needs checking on a device.
- **Still open:** the shared manifest `packages/editor/src/toolbar.ts:229,238` still has
  `when: 'inContainer'`. That generates `ui/ToolbarSpec.kt` (`onlyInContainer = true`,
  regenerated with `just toolbar-spec`), which `ui/EditorToolbar.kt:113,188` uses to hide them.
  Changing the manifest also changes the WebView and desktop embed toolbars, so it is a
  cross-surface change. Coordinate with Justin before doing it.
- **Verify on device:** Indent is greyed on the first item, Outdent on a
  top-level item, both on a paragraph, heading, plain quote or table. Both are lit on code
  lines and other list items.

### 5.2 Tab indent

- **Spec:** `portable-core/list-indent.md:3` (Tab/Shift+Tab in a list item run Indent/Outdent;
  no tab character where the button is disabled); `portable-core/fenced-code.md:9` (code
  lines).
- **Kotlin:** Tab is already routed to the engine. `TextFirstEditText.kt:354` and
  `EngineInputConnection.kt:304` map `KEYCODE_TAB` to `EditorParagraphKey.TAB`/`SHIFT_TAB`
  (FastKeys codes 4/5 → `jni_keys.rs:123-124`). Table cells take Tab first
  (`EditorEngineKeyboard.kt:99`). No Kotlin change is expected.
- **Check (unverified):** how Android draws a real `\t` on code lines (TextView default tab
  stops), and that `\t`-indented items get the right marker depth (`TextFirstSpans.kt:182`
  takes depth from the engine).

### 5.3 Image tap puts the caret after the image

- **Spec:** `mobile/images.md:4` on this branch still says "A short tap on an image selects it
  as one object". Take the new line from `origin/ios-tf/image-tap-caret` (`b02f51b83`).
- **Kotlin:** `ImageTouch.kt`. `settleSelection()` currently sets `selectedObject` and
  `setSelection(start, end)`. Change it to a collapsed caret at the span end. Keep the
  long-press and drag paths selecting. Draw the caret at the image's trailing edge (iOS needed
  `a05415e8e` for that). Backspace from there already removes the whole image (engine !595,
  on the branch).
- Add a `TextFirstTapGestureTest` case.

### 5.4 Link rule FFI (MR !631, merged `2a5e760cd`)

- **Spec:** `portable-core/links.md:10`. It replaces this branch's `docs/spec/editor/external-links.md:66` ("a link whose destination has no
  scheme but names a host … opens over https"), which must go.
- **FFI on the branch** (`crates/futo-notes-ffi/src/editor/links.rs`):
  - the free function `editor_external_link_url(destination) -> String?`;
  - `NativeEditorSession.resolve_note_link(destination) -> String?`;
  - `NativeEditorSession.normalize_link_destination(typed) -> String`. This is
    session-aware: a destination naming an existing note comes back as typed. It replaced
    the free `editor_normalize_link_destination`, which no longer exists.

  In Kotlin these should be `editorExternalLinkUrl`, `session.resolveNoteLink` and
  `session.normalizeLinkDestination`, by UniFFI's camelCase mapping. I haven't checked that
  against generated bindings.
- **Kotlin to change:**
  - `ui/EditorHostCommands.kt:47-61`: replace `SCHEMELESS_HOST` and `externalLinkTarget()`.
    They currently send schemeless hosts to https, drop `sms`, and treat note names as
    non-links. Note that `openExternalUrl` is shared with the WebView editor
    (`EditorHost.openExternalUrl`), so either keep the WebView path as it is or change both
    deliberately.
  - `TextFirstEditorScreen.kt:410` / `TextFirstNoteView.kt:43` (`onOpenUrl`): a schemeless
    destination calls `resolveNoteLink` and navigates to the note.
  - `ExternalLinkTouch.kt`: the tap is consumed only if `open` returns true. Keep that
    contract: a missing note is an ordinary caret tap.
  - `TextFirstLinkDialog.kt` / `EditorEngineLinks.kt`: pass the typed destination through
    `session.normalizeLinkDestination` (on the editor thread) before `editLink`.
- **Tests:** `ui/ExternalLinkTargetTest.kt` (JVM), `TextFirstLinkTapTest`, `TextFirstLinkTest`.

### 5.5 Quote-keep (MR !632, merged `74e124e8b`)

- **Spec:** `portable-core/lists.md:21`: a Bullet, Ordered or Task command on a quoted
  paragraph or empty quoted line creates the item inside that quote (`> - x`).
- **Where:** !632, the lists fold. It folded !606, !608, !611, !615, !617, !622 and !625, and
  dropped !613 (Outdent on a top-level item is disabled under !604). It also took D1 and
  Codex's nested-item Backspace regression test from `ios-tf/codex-fixes`.
- **Kotlin:** none expected. Check quote bar plus list marker drawing for `> - x`, and whether
  Android shows iOS's residual "a toolbar list on a quote adds a blank line on the first
  keystroke".

**Spec bookkeeping.** `docs/spec/editor/mobile/` differs between the two branches
(`git diff origin/android-text-first origin/ios-text-first -- docs/spec/editor/mobile/`).
Carry the shared *(mobile)* changes onto this branch. Keep Android's own *(Android)* lines.

## 6. Kotlin → Rust migration opportunities (follow-ups, not blockers)

All of these host APIs are on main and on the branch. Each swap deletes Kotlin and makes Android share iOS's code path.
Do them one at a time, each with its owning device tests.

| Kotlin today | Rust on main | MR | Notes |
|---|---|---|---|
| `DisplayIndex.kt` (219 lines), `DisplayMirror.kt` index half | `host::DisplayMirror` / `EditorDisplayMirror.apply_change` (returns UTF-16 edit and selection) | !589 | The Rust mirror has no revision check (!589 review M1), so it is not a drop-in replacement for all of `DisplayMirror.kt`. |
| `SpanPlan.kt` `planSpans` / `splitAtLines` | `NativeEditorSession.style_plan(expected, byteRange)` → `[EditorStyleSpan]` (UTF-16, cut at line ends) | !592 | The FFI uses `map_or(0, ..)` on conversion errors (open shared follow-up). !631 added CRLF empty-row spans. A lone `\r` before `\r\n` in a window disagrees with the whole plan (LOW, latent until a host uses windows). |
| `SpanPlan.kt` image branch (`SpanSpec.Image`) | `EditorStyleSpan.Image` | !593 | |
| `TextFirstToolbar.kt` `toolbarActive`, `EditorEngineCaret.kt` disabled-id set | `NativeEditorSession.toolbar_highlights()` | !594 | Known low-severity bug: H4–H6 light "paragraph" in the Rust mapping. Android hides "paragraph" anyway. |
| `EditorEngineTables.kt` `tableSpans`, lookup half of `publishCell` | `style_plan` `TableRow`/`TableDelimiter` + `NativeEditorSession.cell_view` | !596 (incl. !602) | !602 also removed quadratic `inspect_tables` work (8,000 lines took 40 s). iOS needed three windowed-table follow-ups (`mrqa-engine-artifacts/mr-596/recheck.md`). Android's prefix streaming may avoid them; unverified. |
| `EditorEngineFind.kt` `snapshot` (UTF-16 marks, hidden while composing, reveal target), `findStep` first-press rule | `find_snapshot`, `find_step_landing`, `EditorFindLanding` | !598 | `FindMarks.kt` (drawing) stays. |
| `EditorEngineOpening.kt` `selectWhileOpening`, `RenderWork.map` | `host::PendingEdits` / `EditorPendingEdits` | !603 | |
| `EditorEngineStream.kt` `OpenSlices.sliceEnd`; `EditorEngineStorage.kt:101` `display.startsWith(quick)` | `EditorDisplayMirror.slice_end`, `begins_with` | !603 | |
| `EditorEngineStorage.kt:71` `showQuickOpen` (`window(quick.projection, tableSpans(...))`) | `host::plan_quick_open`, `NoteStore.quick_open_view` → `EditorQuickView` | !603 | |
| `ToolbarCommandGate.kt` | none | — | Stays Kotlin; iOS runs commands differently. |

Nothing to migrate for !595 (image Backspace), !597 (carried formats across OS replace) and
!600 (heading toggle ignores blank lines). They are engine-only and Android benefits once main
is merged.

