# Code colours (`cc`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/code-colours.md`. Ruling: do not build. This is the one known "not on Android" feature (Mason's pick P054: no syntax colouring on Android in this pass). To build it, Android needs a highlighter of its own, which is a new dependency and Mason's call.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| cc-1 | Colours code whose language names one of ~35 grammars, by name or alias. | Android's earlier decision | P054: no colouring in this pass. Needs an Android highlighter (new dependency). | uncoloured (P054) | recommend, not built |
| cc-2 | Fetches each grammar on first use; colours arrive with nothing moving. | Android's earlier decision | P054. | uncoloured | none |
| cc-3 | Uses theme.css's `--syntax-*` palette; comments muted and slanted. | Android's earlier decision | P054. | uncoloured | none |
| cc-4 | Draws tokens as spans, so caret, selection and copy are unchanged. | Android's earlier decision | P054. | uncoloured | none |
| cc-5 | Parses nothing per keystroke; recolours changed blocks in slices after paint. | Android's earlier decision | P054. | uncoloured | none |
| cc-6 | Leaves a block over 200,000 characters uncoloured. | Android's earlier decision | P054. | uncoloured | none |
| cc-7 | Recolours a block when its language changes. | Android's earlier decision | P054. | uncoloured | none |
| cc-8 | Puppet names token classes and reports `colouring`. | Android's earlier decision | P054. | uncoloured | none |
