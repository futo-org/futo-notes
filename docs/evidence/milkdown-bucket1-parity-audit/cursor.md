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
