# Accessibility

### AX01

- **Rule:** VoiceOver, Narrator and Orca can read and edit the desktop document before merge.
- **Why / history:** Mason, 2026-11-04 option 7A makes this a slice-10 gate; no device/browser run in this research establishes it.
- **Evidence:** docs/plan/desktop-editor.md
- **Applies:** `slice 10`. **Check:** needs screen-reader stories on macOS, Windows and Linux

### AX02

- **Rule:** The native selection remains synchronized and reachable despite a custom drawn caret and highlight.
- **Why / history:** IME, zoom and screen readers follow the native range rather than the painted rectangles.
- **Evidence:** docs/plan/desktop-editor.md; desktop/editing.md
- **Applies:** `desktop now`. **Check:** needs VoiceOver selection/caret reading story

### AX03

- **Rule:** Atoms expose meaningful content and state without reading hidden syntax as editable text.
- **Why / history:** !300 recorded fence syntax being read aloud; #398 records missing image alt text in iOS, deferred there by Justin.
- **Evidence:** !300; #398; docs/plan/desktop-editor.md
- **Applies:** `slice 5`. **Check:** needs desktop image alt, checkbox and code-object reading stories

### AX04

- **Rule:** Toolbar controls have localized labels and real enabled/disabled semantics.
- **Why / history:** !300 review caught untranslated Highlight/Lowlight labels; visual dimming alone was previously accepted by neither mobile toolbar nor tests.
- **Evidence:** !300 discussion; markdown-toolbar/toolbar-commands.md; AGENTS.md §5
- **Applies:** `slice 3`. **Check:** needs accessible-name and disabled-action story

### AX05

- **Rule:** All document text remains available to assistive technology even in a long note.
- **Why / history:** The desktop plan rejects virtualization for now and keeps DOM lines accessible; custom band painting cannot replace the semantic selection.
- **Evidence:** docs/plan/desktop-editor.md; docs/learnings/large-file-editing.md
- **Applies:** `desktop now`. **Check:** needs long-note read/navigation story

### AX06

- **Rule:** Loading and failure states are visible and announced without presenting a blank editable note.
- **Why / history:** Milkdown's progressive loader has role=status; the failed-note state keeps original bytes read-only.
- **Evidence:** docs/spec/editor/performance.md; cursor/a-note-the-editor-cannot-hold.md
- **Applies:** `later: progressive open`. **Check:** needs loading/cancel/failure announcement story

### AX07

- **Rule:** Editor dialogs have an accessible title, trap Tab, close only the top overlay on Escape and return focus to their opener.
- **Why / history:** !241 fixed ignored Escape through shared dismissal composition; per-panel handlers also missed unfocused dialogs. Editor prompts must retain the same contract.
- **Evidence:** !241; src/shared/dialogs/Modal.svelte; src/shared/dialogs/dismissable.ts.
- **Applies:** `slice 3`. **Check:** shared dismissable tests; needs keyboard-only Link prompt story.

### AX08

- **Rule:** Selected text remains readable and visibly selected in both themes on every desktop engine.
- **Why / history:** !34 fixed a CodeMirror-specific selector and WebKit's alpha handling after selection colors became too dim or bright; matching a Chromium screenshot did not establish WebKit contrast.
- **Evidence:** !34; desktop/editing.md selection painting.
- **Applies:** `desktop now`. **Check:** needs light/dark selection stories with formatted text on WKWebView, WebView2 and WebKitGTK.
