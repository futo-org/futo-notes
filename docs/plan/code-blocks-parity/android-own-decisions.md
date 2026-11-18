# Decisions on the Android editor that Mason did not make

Every choice the Android work made itself: by the implementer, a verifier, or the reviewer (Mason's own decisions are in the parity tables' Target column, not here). One line each: what Android does; where it differs (from the **!300 app**, from **!300's spec**, or from **desktop**); why; how hard to reverse (`one line`, `small`, `large`) and where.

The per-area items from `VERDICT.md` (every `leave` and every `ask Mason`) are in [android-own-decisions/by-area.md](android-own-decisions/by-area.md).

## Guards Android adds around code blocks

- **The code toggle does nothing on a block selected as one object.** Differs from desktop (the engine would unwrap it) and from the !300 app (no such button). Why: unwrapping a block on a tap of the toolbar lost its fences with no warning; P155. Over a range that takes a block it still wraps (TextFirstBlockIndicatorTest pins it). Reverse: `one line` (TextFirstController.block).
- **The caret's teardrop handle is dropped when it would hang over "add a line below".** Differs from the !300 app (its handle stays and eats taps on the strip). Why: the label must win its box (area 3 ruling); the handle's own window takes every tap. Reverse: `small` (CodeLineBelowHandle.kt).
- **A drag anchored in code is clamped to that code** (both ends inside the block); a drag from prose takes every block it reaches whole. Same as !300's spec (cb 110-130); Android paints the clamped range and sends it to the engine, never rewriting the native selection. Reverse: `large` (CodeSelection.kt, CodeSelectionPaint.kt).
- **A selection made from the line below a block starts past the block's line break** (P166, Mason's rule; the exact form is ours: a range that only meets the block's end). Reverse: `one line` (CodeSelection.kt).
- **A selection the engine sets (Select All, undo) is painted as it is**, not clamped as a drag. Why: Select All over two touching blocks painted only the first block. Reverse: `small` (CodeSelectionPaint.kt `settled`).
- **The view's own collapse on blur is sent as an ordinary selection, not a placement.** Why: placed forward at the end of `**bold**` turned the toolbar's Bold off after the keyboard was dismissed (bisected to bf4346afc). Reverse: `small` (TextFirstEditTextReveal.kt, EditorEngine.viewSelection).
- **A keyboard's one-step delete over a selection is Backspace (or Delete) on it.** Why: FUTO Keyboard sends Backspace over a selection as "delete the character before", which removed the text above a selected block. Differs from the InputConnection contract's literal meaning. Reverse: `one line` (EditorEngineKeyboard.imeDeleteSurrounding).
- **Move keys the note cannot use (Up at its start, PageDown at its end) are kept by the note** instead of moving focus to the title. Differs from Android's default focus search; matches the !300 app. Reverse: `one line` (TextFirstEditText.onKeyDown, NOTE_MOVE_KEYS).
- **Down on the last line of a block that ends the note opens a line below it.** Same as the !300 app and Mason's pick for a selected block; the extension to a caret on the last line is ours. Reverse: `small` (CodeBlockKeys.downOutOfLastBlock).
- **An arrow from a selected block toward an empty block at the note's edge leaves the selection.** !300's spec (cb 868-869). Reverse: `small` (CodeBlockKeys.isEmptyBlockAtEdge).
- **Code input (no capitals, no suggestions) only while the caret is in code and no block is selected as an object.** Why: typing over a selected block writes prose. Reverse: `one line` (TextFirstEditText.refreshCodeInput).
- **A selected empty block hides the caret and handle.** Matches the !300 app. Reverse: `one line` (TextFirstEditText.selectedCodeBlock setter).

## Header fields (name, language)

- **Each keystroke in a header field writes the fence at once** (engine `set_code_block_header` per change). Same as !300 (cb 285-299); differs from desktop, which writes once on leaving with Escape restoring. Reverse: `small` (CodeHeaderField.write).
- **The fields are a separate EditText laid over the note**, placed every frame. Why: the note is one TextView; a field inside it is not possible. Reverse: `large`.
- **The language field shows the fence word (mono), not the label**, while edited. Same as !300's input. Reverse: `one line`.
- **The keyboard opens lowercase in the language field, with no suggestions** (`TYPE_TEXT_FLAG_NO_SUGGESTIONS`). Differs from the !300 app (capitals, suggestions). Why: a language is a lowercase word. Reverse: `one line` (CodeHeaderField inputType).
- **The action key is "Go" (→)**; Enter, Down and the action key go to this block's code. !300's spec; the !300 app shows "next" (›) and jumps to the next block's name. Reverse: `one line` (imeOptions).
- **Field text is inked as body text, its caret thin (1 dp) in the same ink.** Read from the !300 app. Reverse: `one line`.
- **Ctrl+Z / Ctrl+Y in a field go to the note's history**, one keystroke each, and the field follows. Matches the !300 app. Reverse: `small`.
- **Shift-Tab at a block's first code position opens its language field** (P220). !300's spec. Reverse: `one line`.
- **The keyboard closing with a field open closes the field.** Matches the !300 app. Reverse: `one line` (CodeHeaderField.place).
- **A field the keyboard covers is revealed in one movement, as the keyboard starts to rise; a field it does not cover never moves the note.** Matches the !300 app. Reverse: `small` (CodeHeaderField.keepInView).
- **When leaving a field brings the editor toolbar back over the caret's line, the note moves (up to 168 px at the note's end).** Reviewer's ruling: the line must stay visible; the !300 app leaves its caret under its toolbar. Reverse: `small`.
- **The editor toolbar keeps the state it had when a field opened** (hidden if the keyboard was down, shown if up). Matches the !300 app. Reverse: `one line` (TextFirstController focus listener).
- **While a field is open its block stays active** (ghost "name", "add a line" labels). The !300 app keeps them only if the block was active before. Reverse: `one line` (TextFirstEditTextCode `editingHeader`).

## Typing and pairing

- **A character counts as plain typed for pairing when the keyboard commits exactly one code point with no composition open**, or a hardware key types it; a longer commit types as given; compositions, paste and text-service replacements never pair. Reviewer's instruction made concrete by the implementer. Reverse: `one line` (EditorEngineKeyboard.typedAction).
- **A composition commit that ends in a pair key (`world*`) commits the word, then types the key as a paired key.** Why: FUTO's autocorrect sends the closing `*` with its correction. Reverse: `small` (EditorEngineKeyboard.pairKeyAfterCorrection).
- **The third backtick opens the new block's language field.** Same as !300 (writes_language). Reverse: `small`.

## Visual values not read from the reference

- **Colours come from the app theme**, not !300: selection (accent at 25%), caret #FF9000 (!300 #F26B1F), body text #1E1E1E (!300 #0F0F0F), the copy confirmation grey (!300 orange). Reverse: `small` each (TextFirstStyle).
- **The card stands 6 dp outside the text column; the note's text inset is 18 dp** (!300: 16 + 6 CSS px), so cards are about 27 px wider. Reviewer's ruling: keep the note's inset. Reverse: `one line` (codeCardOutset) / the inset is the editor's.
- **Code is JetBrains Mono** (the app's mono font); !300 uses the system monospace. Reverse: `one line` (TextFirstStyleFromTheme), but it changes every code line's width.
- **Chrome sizes are !300's CSS px at our 17 sp body** (header 27, skirt 10, gap 4, fields 2 px in, code 15.84 on 27.72). Read from the !300 app; the 17-sp base is ours. Reverse: `one line` (TextFirstStyle.codeMetric).
- **The caret is cut to its text's height** (the platform caret's width), **and in code it is as tall as in body text** (Mason's rule; the 77 px value and centring on the code are ours). !300's caret is 82 px in body, 70 in code. Reverse: `small` (TextFirstEditTextCaret.kt).
- **The field caret is 1 dp wide.** Reverse: `one line`.
- **The selection band in code fills the whole row** to the card's inner edge; !300's is text-height. Reverse: `small` (CodeSelectionPaint.drawSelectionRows).
- **A long name is cut at !300's character count** (its 45% counted in !300's glyphs), because our mono glyphs are wider. Reverse: `one line` (CodeBlockChrome.nameChars).

## Things not done

- **Line marks (`hl:`, `ll:`) are neither drawn nor settable**; the fence keeps their text. Mason dropped them for now (2026-11-17). Reverse: `large` (the menu and bands were removed in 195b31b41).
- **No syntax colouring.** Desktop colours code with JavaScript grammars; Android would need its own highlighter (a new dependency). Mason's call. Reverse: `large`.

## The test bed (choices that shaped behaviour)

- **S23 size on API 36 emulators** (`wm size 1440x3088`, `wm density 600`); no API 37 image. Every pixel value in VERDICT.md is at this size.
- **FUTO Keyboard 0.1.30 as the default keyboard**; Gboard only for the pairing and toolbar checks. Behaviour that depends on the keyboard (Backspace over a selection, autocorrect carrying a pair key) was fixed for FUTO first.
- **adb input sends each event as its own gesture**: long-press-then-drag rows were judged with kernel touch events or device tests, not adb.
- **The !300 app ran in a WebView on the same emulator size**; its quirks (no handles, no tag row) limited some comparisons.

## Translation rulings for the phone (made by the reviewer, 2026-11-17)

- The language chip keeps !300's touch rule (a tap copies unless the caret is in the block; a hold edits); desktop's "click edits" is not copied.
- The phone toolbar's Bold/Italic/Strike at a caret keep pending-format; Heading and Quote grey out where the engine's toolbar state says they do nothing, if the FFI exposes it.
- Images keep Android's own drawing; Mason's image rules are measured and only small host mismatches fixed.
- Android's tap rule for opening a link stays as the phone form of "a plain click opens it".
- Find keeps Android's find bar.
- Front matter and tags are left as they are until the redesign.
- Syntax colours are not built.
- Table controls, quick open and outside changes stay open with Mason.

## Desktop rules in their phone form (2026-11-18)

- **Toolbar Bold/Italic/Strike at a caret inside a word, or at its start, toggle the whole word**; at a word's end or away from words they are pending. Differs from the ruling as written ("keep pending-format at a caret"); it is the engine's own mobile rule (`toggle_toolbar_format_view`) and mobile/toolbar.md, so it was not overridden. Reverse: `one line` (call `toggleFormat` from the toolbar).
- **Ctrl+Alt+X is strikethrough, Ctrl+E inline code, Ctrl+Alt+1-6 headings, Ctrl+Alt+7/8 lists, Ctrl+Shift+B quote** (desktop's chords; Ctrl stands for Cmd). Ctrl+Alt+X used to cut. Reverse: `small` (TextFirstShortcutKeys.kt).
- **Backspace after a wikilink, or Delete before it, deletes it whole**, read from the engine's style plan on the editor thread. Desktop's rule; the engine leaves it to the renderer. Reverse: `small` (EditorEngineKeyboard.wikilinkBesideCaret).
- **Built from a desktop decision, phone form: Backspace right after an image, or hardware Delete right before it, selects the image; the next press deletes it.** Mason's rule; the engine deletes at once, so the host selects first from the engine's style plan. mobile/images.md now has an Android line and an iOS gap. Reverse: `small` (drop the Image branch of EditorEngineKeyboard.atomBesideCaret, restore the spec line).
- **Built from a desktop decision, phone form: a selected image is tinted with the selection colour over the picture.** Reverse: `small` (delete ImageSelectionTint.kt and its two calls).
- **A find match is clipped to its text row in code**, as the selection is. Reverse: `one line`.
- **The 23 other measured differences are recorded, not built** (desktop-decisions-on-android, "not built"): over the 50-line limit, or not clearly Mason's.

## From the earlier polish branch, still in this build

- H2 keeps its natural height (not snapped to a grid).
- The caret is cut to its text and tinted with the accent.
- Bullets scale with the font size.
- A table is drawn as one grid (not row by row).
- The title has an 18 dp inset, shared with the body.
- Selection handles use the accent colour.
