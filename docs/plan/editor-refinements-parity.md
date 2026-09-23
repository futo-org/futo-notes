# Editor refinements: Android and desktop parity

Handoff for an agent with no prior context. On 2026-09-23 Justin reported a
batch of editor bugs on his iPhone, and they were fixed on the iOS side on the
`editor-refinements` branch. This doc lists each resulting behavior, says which
platforms it applies to, and says how to check it. Your job is to make every
applicable behavior true on **Android** and **desktop**:

1. Verify it by running the app on that platform. Reading the code only tells
   you where to look.
2. If it is already true, record PASS with evidence.
3. If it is missing or broken, implement it (test-first where the layer allows),
   then verify it on the platform again.
4. Update the spec (`docs/spec/`) to match. This doc names each open gap line
   you will close.

## Before you start

- **Check that you have the iOS work.** Run `git log --oneline main..HEAD` and
  `rg -n "revealSelection|navigationPopGestures|focusBody" src apps/ios`. If
  those symbols are missing, your checkout doesn't have the iOS changes. Stop
  and ask; do not re-derive them.
- **Load `/verify`** and use its playbooks: `.claude/skills/verify/references/android.md`
  and `desktop.md`. They cover device claiming, building, driving, and
  screenshots. Load `/spec-sync` before you edit the spec.
- **Claim devices through the pool** (`just qa-claim android`). Other sessions
  run in parallel on this Mac. Never send OS-level input to the desktop app, and
  never activate windows or steal focus (see desktop.md "CRITICAL").
- Commit on the working branch. Do not merge.

## What is shared and what is not

This decides whether a behavior comes to a platform for free.

| Code | iOS | Android | Desktop |
|---|---|---|---|
| `src/features/editor/milkdown/**` (the editor component, its CSS, table grips) | yes | yes | yes |
| `src/editor-embed/**` (the embed entry: `main.ts`, `createFutoEditorApi.ts`) | yes | yes | **no**. Desktop mounts `MilkdownEditor` through `NoteWorkspace.svelte` |
| Native shell code | `apps/ios` | `apps/android` | `src-tauri` + `src/app` |

Android's `app/src/main/assets/editor.html` is **gitignored and built** from the
embed. Rebuild it (`just android-native`) before you judge any shared-bundle
behavior on Android, or you will be testing a stale bundle.

The editor's `blur()` is called only by the embed (native keyboard dismiss and
the web toolbar's dismiss). Desktop never calls it.

## Behaviors

Each entry gives the user-visible requirement, then the iOS reference, then
what to do on each platform. "iOS ref" names the mechanism. It is a starting
point, not a design to copy: port the **behavior** in each platform's own
idiom.

### B1. A new note opens with the caret in the body and the keyboard up

- **Requirement:** creating a note (iOS compose button, Android "+" FAB, desktop
  new note) opens the editor with the caret in the empty body. On a phone the
  soft keyboard is up. It must work on the first note after a cold launch, when
  the editor may still be loading, not only on a warm editor.
- **iOS ref:** `apps/ios/Sources/Editor/EditorWebView.swift`
  `EditorHost.startAutoFocus` / `runPendingAutoFocus`. It waits until the
  editor screen is in a window, takes native first responder, runs the page
  focus script, and closes the "force keyboard" gate only after that script has
  run.
- **Android:** probably present already. `EditorHost.focusEditor`
  (`ui/EditorWebView.kt`) does DOM focus, then `requestFocus()`, then retries
  `showSoftInput`. **Verify both cases:**
  1. Warm: open any note, go back, tap the FAB.
  2. Cold: force-stop the app, launch it, tap the FAB as soon as the list shows.

  Pass: the caret blinks in the body and the keyboard and toolbar are up,
  without tapping. The editor's `ready` can land after `attach`, so check that
  the `autoFocus` path at `EditorWebView.kt` lines ~540 and ~797 still focuses
  when the order flips.
- **Desktop:** check that a new note puts the caret in the body, not the title,
  and that you can type immediately. There is no keyboard to check.
- **Spec:** `docs/spec/list.md`, "A new note opens with the caret in the body".
  Add a dated Android verification to that line.

### B2. Return in the title moves into the body

- **Requirement:** in the note's title field, Return (the IME action key, or
  Enter on a hardware keyboard) commits the title and moves the caret into the
  note body. On a phone the keyboard **stays up**, so typing continues into the
  body. The title never gets a newline.
- **iOS ref:** `apps/ios/Sources/Notes/Editor/NoteEditorView.swift`
  `TitleTextField` `textFieldShouldReturn` calls `EditorHost.focusBody()`,
  which runs the same focus path as B1.
- **Android: likely missing.** The title `BasicTextField` in
  `ui/NoteEditorScreen.kt` (~line 939) is `singleLine` with no `keyboardOptions`
  or `keyboardActions`, so the IME action probably just drops the keyboard.
  Verify first. If it is missing:
  - Give the field an IME action (`ImeAction.Next` reads right) whose handler
    moves focus into the editor through the existing `focusEditor()` path.
  - Make sure the title's pending rename still commits. Its 500 ms debounce
    must not be lost when focus moves.
  - The keyboard must not visibly drop and come back up.
  - Check hardware Enter too. `onValueChange` strips `\n`, so that alone does
    nothing.
  - Add a test at the layer that supports it (Compose UI test or
    instrumented), next to the existing editor-screen tests.
- **Desktop:** probably present. `src/features/notes/createNoteTitleController.svelte.ts`
  `handleKeydown` calls `focusEditor()` on Enter. Verify at runtime: type a
  title, press Enter, type again, and the text lands in the body.
- **Spec:** `docs/spec/list.md`, "Return in the title moves on into the body".
  Close its `> **Gap (parity):**` block once Android passes.

### B3. A tapped caret is revealed above the keyboard as the keyboard rises

- **Requirement:** in a note long enough to fill the screen, tap the last word
  near the bottom. As the keyboard comes up, the note scrolls so that word sits
  above the keyboard and toolbar. It must happen right away, not only on the
  first keystroke.
- **iOS ref:** shared. `src/editor-embed/main.ts` adds a window `resize`
  listener that calls `editor.revealSelection()` on the next frame, and
  `MilkdownEditor.svelte` `revealSelection` dispatches `tr.scrollIntoView()`
  when the view has focus. ProseMirror only scrolls on its own transactions,
  and a tap is not one.
- **Android:** ships in the shared bundle. Verify it on a rebuilt app:
  - The editor `Column` uses `imePadding()`. Check that this actually resizes
    the WebView so the page gets a `resize` event. You can check with CDP
    (android.md §4).
  - Chromium may already have revealed the caret on its own. Either way, record
    what you observe.
  - Pass: the tapped word is visible above the toolbar once the keyboard
    settles, with nothing typed.
- **Desktop:** N/A. There is no soft keyboard, and desktop does not load
  `editor-embed/main.ts`.
- **Spec:** `docs/spec/editor.md` "Native touch and focus", the "A caret the
  keyboard rises over…" line. Close its Android gap.

### B4. The keyboard toolbar's background matches the editor's

- **Requirement:** the band behind the markdown toolbar above the keyboard is
  the editor's own background colour. There is no colour step between the note
  and the bar, in light or in dark mode.
- **iOS ref:** `apps/ios/Sources/Editor/Toolbar/EditorToolbar.swift`
  `FutoKeyboardAccessory` changed to `UIInputView(inputViewStyle: .default)`
  with `backgroundColor = UIColor(Theme.background)`. The system `.keyboard`
  material was a near miss the user could see.
- **Android: likely missing.** `ui/EditorToolbar.kt` paints the root `Column`
  `c.surface`, and the two edge-fade gradients also fade from `c.surface`. The
  editor's page background comes from `src/styles/theme.css`. The Compose
  theme's `background` is `FutoPalette.N50` (light) / `InkBg` (dark), in
  `ui/theme/Theme.kt`. Screenshot the editor with the keyboard up in both
  themes, then sample the pixel colour just above the bar and on the bar. If
  they differ, switch the bar and both fades to the colour that matches the
  editor page. Don't pick a new palette entry by eye. Keep the active-button
  highlight readable.
- **Desktop:** N/A. There is no keyboard toolbar.
- **Spec:** `docs/spec/editor.md` "Markdown toolbar". The first new line says
  the band is the editor background _(native shells)_. Close the Android gap
  under the iOS backdrop line.

### B5. Dismissing the keyboard clears the caret, selection, and table grips

- **Requirement:** dismissing the keyboard ends the editing session on the
  page, not just the keyboard. Afterwards there is no caret, no highlighted
  text range, no table cell selection, no selection handles, and no table
  row/column grips left over from a tap.
- **iOS ref:** shared. `MilkdownEditor.svelte` `blur()` collapses the selection
  to its head, dispatches `hideTableGrips(tr)` (`table/tableGrips.ts`, a
  plugin-state counter that the grips view hides on), blurs the DOM, and calls
  `getSelection().removeAllRanges()`.
- **Android:** ships in the shared bundle, and both Android dismissal paths
  already call the bridge `blur()`: the chevron
  (`NoteEditorScreen.kt ToolbarItemAction.Dismiss`) and the back-gesture IME
  dismissal (`MainActivity.kt ClearFocusOnImeDismiss`). Verify on a rebuilt app
  with **each** path:
  1. Select a word range, then dismiss. No highlight or handles remain.
  2. Tap inside a table so the grips show, then dismiss. The grips are gone.
  3. Drag across cells to make a cell selection, then dismiss. It is gone.
  4. Tap back into the note. Editing works normally and the grips reappear
     when you touch the table again.
- **Desktop:** N/A. Desktop never calls `blur()`. Confirm that is still true
  (`rg "\.blur\(\)" src`) so that clicking out of the editor on desktop keeps
  its current behavior.
- **Tests:** no automated test was added on iOS. Add a Playwright case in the
  embed suite (for example `tests/editor-embed-milkdown-table-grips.spec.ts` or
  `tests/editor-embed-milkdown.spec.ts`): place a range selection and show the
  grips, call `window.FutoEditor.blur()`, then assert the selection is collapsed
  and no `.futo-table-grip` is visible. It runs in Chromium, so it covers
  Android's engine directly.
- **Spec:** `docs/spec/editor.md` "Markdown toolbar", the "Dismissing the
  keyboard ends the editing session…" line. Close its Android gap.

### B6. A lifted block moved sideways never swipes back or sticks

- **Requirement:** in the native long-press block drag, moving a lifted block
  left or right never starts back navigation. When the finger lifts, the block
  always drops or cancels. It is never left in the "popped" lifted state with
  no finger on it.
- **iOS ref:** `EditorWebView.swift`. While a block is airborne,
  `applyTextInteractionLevel(.full)` also disables `navigationPopGestures()`
  (`interactivePopGestureRecognizer` plus iOS 26's
  `interactiveContentPopGestureRecognizer`). The content pop took horizontal
  drags from anywhere and swallowed the touch end, which is what left blocks
  stuck.
- **Android:** verify. Android's back gesture starts only at the screen edge,
  so a drag that begins mid-screen should be safe, but check these:
  1. Lift a block mid-screen, move it slowly left and right a few times,
     release. It drops and nothing navigates.
  2. Lift a block and drag it all the way to the left and right screen edges,
     then hold and release there. There is no back or predictive-back
     animation, and no stuck lift.
  3. Lift a block, then interrupt the gesture (for example, bring up the
     notification shade with a second finger if the emulator allows it). The
     block must return to rest.
  4. Repeat on a note that is a single block (the user hit this on a one-block
     note) and on a freshly opened note.

  If a block sticks, the fix probably belongs in the shared drag's
  `pointercancel` / `touchcancel` handling (`mobileBlockDnd.ts`) as well as in
  the shell.
- **Desktop:** N/A. There is no long-press drag, and the ⠿ gutter handle is a
  pointer drag with no back gesture.
- **Spec:** `docs/spec/editor.md` "Selection", the "Moving an airborne block
  sideways never starts a back-swipe…" line. Close its Android gap.

### B7. An empty list item shows its marker immediately

- **Requirement:** starting a bullet or numbered item from the toolbar (or
  otherwise creating an item whose only line is empty) shows its marker at
  once, before any typing. Nothing extra appears in the saved Markdown.
- **iOS ref:** shared CSS in `MilkdownEditor.svelte`:
  `li > p:first-child:has(> br.ProseMirror-trailingBreak:only-child)::before { content: '\200b' }`.
  iOS WebKit paints no marker for a line that is only ProseMirror's trailing
  `<br>`.
- **Android:** ships in the shared bundle. On a rebuilt app, tap Bullet and
  then Numbered on an empty line; each marker must show before you type. Then
  type a character and confirm the caret sits right after the marker, with no
  extra gap. Background the app and read the file (android.md §6): it contains
  `- ` / `1. ` and no zero-width character.
- **Desktop:** the rule applies everywhere. On the Tauri app, repeat the check
  (desktop has no toolbar, so type `- ` or `1. ` on an empty line). If you can
  reach them, also check Linux WebKitGTK (jfedora) and Windows WebView2 (the
  qemu VM, windows-vm.md). Pass: the marker is visible, the caret is in the
  right place, and the file is clean.
- **Tests:** consider a Playwright assertion that the `::before` rule applies
  to an empty item. Chromium paints the marker anyway, so a screenshot there
  proves nothing about WebKit.
- **Spec:** `docs/spec/editor.md` "Markdown elements (rendered / decorated)",
  the "An empty list item shows its marker" line. It has no gap. Add dated verification per platform.

## Out of scope: do not port

- **Enter before a photo in a bullet.** The iOS branch briefly changed what
  Enter twice does with the caret before an image in a list item, and Justin
  reverted it because the old behavior (the list continues) is what he wants.
  Leave it alone on every platform.
- **iOS-only mechanisms** such as the window wait, the keyboard gate, the
  first-responder workaround, `UIInputView` styles, and pop recognisers. Port
  the behaviors above, not these internals.

## Lesson from the iOS side

The B1 and B2 fixes passed on an iOS 26.5 simulator and then failed on
Justin's iOS 27 phone. iOS 27 WebKit stopped reporting a script focus while the
web view isn't first responder. Engine versions matter, so record the Android
System WebView version (and the emulator API level) next to every Android
verdict. If Justin's own Android device is available, prefer it for B1, B2, and
B4.

## What to report back

One table: behavior × {Android, desktop} → **PASS** (already true), **FIXED**
(implemented and re-verified), **N/A** (with the reason above), or **BLOCKED**
(what stopped you). Add an evidence column: a screenshot path under
`test-screenshots/`, a test name, or a file read-back. Then list:

- the commits,
- the spec lines changed and each gap closed (with dates),
- and anything you found that this doc got wrong.
