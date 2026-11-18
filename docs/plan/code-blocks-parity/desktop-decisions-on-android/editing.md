# Rendering, input, caret and saving (`ed`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/editing.md`.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| ed-1 | Shows the engine's display text with markers hidden; every row one line unit; 16/24 type. | engine | The text is the engine's; Android keeps its own type size. | same | none |
| ed-2 | Sets heading sizes and weights (24/700 ... 17/500). | host: phone form | The same ratios. | same ratios (markdown-elements.md, headings) | none |
| ed-3 | Draws bold, italic, strike and inline code as the engine's runs say; bold one step heavier. | host: phone form | The same. | bold in a heading is heavier (markdown-elements.md) | none |
| ed-4 | Mod+B/I/E, Mod+Alt+X toggle a format; at a caret it applies to what is typed next; Mod+Alt+1-6 make headings. | host: phone form | Hardware Ctrl chords. Toolbar Bold/Italic/Strike at a caret keep pending-format (Mason). | Ctrl+B/I/E, Ctrl+Alt+X, Ctrl+Alt+1-6 built (e0d9b4610; Ctrl+Alt+X used to cut). Toolbar at a caret inside a word or at its start bolds the word (engine's mobile rule, toggle_toolbar_format_view); at a word end or line end it is pending | open with Mason: the toolbar follows the engine's mobile rule and mobile/toolbar.md, not pending-format everywhere |
| ed-5 | A format that cannot apply (bold inside inline code) does nothing. | engine | inline-formatting.md. | dimmed when not allowed (mobile/toolbar.md) | none |
| ed-6 | A non-empty selection shows the selection toolbar. | host: phone form | The keyboard toolbar, always shown while editing. | same | none |
| ed-7 | A caret at a format's edge is on one side, set by how it came there; typing takes that side's formats. | host: phone form | A tap takes the side of the character tapped. | the side at a format edge is fixed: inside at a start, outside at an end | differs; host caret-side rule, large; not built |
| ed-8 | Left/Right leave the caret on the side of the character last passed. | host: phone form | Hardware keyboard only. | same fixed side with arrows | differs; same cause as ed-7 |
| ed-9 | Inline code's edges are two stops each, so the caret can leave code that ends a line. | host: phone form | Hardware arrows; a tap inside or outside the code's box. | inline code ending a line can be left, but its end cannot be typed into | differs; same cause as ed-7 |
| ed-10 | Draws the caret inside the code box when the next letter is code, outside when not. | host: phone form | The same. | same | measured |
| ed-11 | A click takes the side under the pointer (code side on its box). | host: phone form | A tap. | a tap inside the box on its last letter lands outside | differs; same cause as ed-7 |
| ed-12 | Up, Down, Home, End and a placed caret take the side of the character before. | host: phone form | Hardware keys and taps. | to measure | none |
| ed-13 | Shift+Arrow and a selection have no side. | host: phone form | Hardware keyboard. | to measure | none |
| ed-14 | After Backspace the character before gives the formats; after Delete the one after. | engine | The engine's rule. | Backspace through italic leaves italic: blocked: engine (V p.3) | none |
| ed-15 | Draws a flag on the caret naming its formats (H1, B, I, S, <>). | not on a phone | The keyboard toolbar's lit buttons already show the caret's formats. | none | none |
| ed-16 | Dev builds add a caret-side debug section to the note's menu. | not on a phone | A desktop experiment's dev menu. | none | none |
| ed-17 | Redraws a line only where it changed; maps one offset to two DOM points at a format's edge. | not on a phone | DOM drawing detail. | none | none |
| ed-18 | Sends every input through the engine; composition commits through it. | engine | Kotlin forwards input and composition (transports.md). | same | none |
| ed-19 | Pastes the clipboard's plain text as Markdown, never its HTML; Shift+Mod+V is the same. | engine | clipboard.md; Paste in the text menu. | same for plain text; HTML paste not measurable on the emulator | measured in part |
| ed-20 | Mod+Enter opens a line below, Shift+Mod+Enter above; Apple's Ctrl+K/T/O emacs keys. | host: phone form | Hardware Ctrl+Enter, Ctrl+Shift+Enter; the emacs keys are Apple only. | built: hardware Ctrl+Enter opens a line below the caret's line, Ctrl+Shift+Enter one above, the caret on it (TextFirstDesktopRulesTest) | built |
| ed-21 | Draws its own caret over a transparent native one. | not on a phone | Android uses the platform caret (cursor/placement.md). | platform caret, accent colour | none |
| ed-22 | After an edit scrolls a caret outside the pane into view, no more than needed; selection changes scroll nothing. | host: phone form | The same, above the keyboard. | typing reveals with about a line of margin; Shift+Right with the caret off screen scrolls to it | not built: the scroll comes from the platform TextView revealing a selection end the reader moved with a key; stopping it means taking arrow-key selection over from the TextView (not small), and a phone reader moving the end off screen needs to see it |
| ed-23 | The engine's selection is the one selection; native changes go to it. | engine | transports.md. | same | none |
| ed-24 | Always draws the engine's reading; Puppet refuses on drift. | engine | The same. | same | none |
| ed-25 | Mouse: click, double, triple, Shift+click, drag by unit, auto-scroll, drag-and-drop of text. | host: phone form | Tap, double tap word, triple tap line, long-press and drag handles; no text drag-and-drop. | double and triple tap (native-touch-and-focus.md); hold-drag (V 3.1); triple tap's break open (V 3.4) | none |
| ed-26 | A press in an unfocused note puts the caret there and keeps the scroll. | host: phone form | A tap with the keyboard down. | same | measured |
| ed-27 | A caret at a soft wrap stays on the row it was put on. | host: phone form | A tap right of a wrapped row's end. | same, the caret lands before the row's trailing space | measured |
| ed-28 | Up/Down keep the column through a run; Up on the first row goes to the note's start. | host: phone form | Hardware keyboard. | V 13.2 fixed; column open (V 3.7, 13.3) | none |
| ed-29 | Cmd+Left/Right (Home/End) go to the row's ends; Cmd+Backspace deletes to it. | host: phone form | Hardware Home/End. | same (P301); Ctrl+Backspace open (V 5.2) | none |
| ed-30 | Words are the engine's (ICU4X); Option+Left/Right move by word. | engine | Hardware Ctrl+Left/Right. | to measure | none |
| ed-31 | Draws the selection highlight as one band per row, blank lines and breaks included. | host: phone form | The same. | band to a card's border (V 6.12) | none |
| ed-32 | Saves 500 ms after the last edit (2 s at most), on blur, hide, leave and quit. | host: phone form | Save on pause and when the app goes to the background. | Android's own save path | none |
| ed-33 | Budgets its own keystroke work: median under 1 ms, p99 under 2 ms. | host: phone form | Android's own budget (performance/android-text-first.md). | own rules | none |
| ed-34 | Types a long note as fast as a short one. | host: phone form | Android streams a prefix (mobile/long-notes.md). | own rules | none |
| ed-35 | Puppet drives it with shared verbs plus real mouse input. | host: phone form | Android Puppet's verbs. | same verbs | none |
