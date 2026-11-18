# Selection toolbar (`tb`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/toolbar.md`.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| tb-1 | Floats H1-H3, Quote, Bold, Italic, Strike, Code, Link over a selection; hides for a caret. | host: phone form | The keyboard toolbar's buttons, shown while editing. | H1-H3 without Text (mobile/toolbar.md) | none |
| tb-2 | Lights an inline button from `active_formats`; mixed is unlit; disabled where it cannot apply. | engine | Toolbar state. At a caret, Bold/Italic/Strike keep pending-format (Mason). | lit and dimmed from the engine (mobile/toolbar.md) | none |
| tb-3 | Heading runs `ToggleHeading`, Quote runs `Quote`; code, front matter and dividers left alone. | engine | block-commands.md. | same (P155) | none |
| tb-4 | Lights headings and Quote, and greys them where they change nothing (`toolbar_state`). | host: phone form | Grey Heading and Quote out the same way. | blocked: engine: FFI `EditorToolbarSnapshot` has no `heading_allowed` / `quote_allowed` | recommend, not built |
| tb-5 | Over text through a table, formats and Quote leave table lines byte for byte. | engine | inline-formatting.md, block-commands.md. | same (`TextFirstTableFormatTest`; V engine merge) | none |
