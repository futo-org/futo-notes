# Paired typing (`pt`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/paired-typing.md`.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| pt-1 | Sends a typed key as `PairedTyping`: backtick, `*`, `~`, `[`, `]` pair, grow, step over; three backticks make a block. | engine | Phones pair too (Mason, P330). | as decided, FUTO and Gboard (P330-P339; V phone pairing) | none |
| pt-2 | Sends every Backspace as `PairedBackspace`; after a wikilink it deletes the wikilink whole. | engine | The same. | one level per press (P337); empty-pair presses open (V 5.6) | none |
| pt-3 | A key that only moves the caret returns no edit; the page reads the selection back. | engine | paired-typing.md. | same | none |
| pt-4 | Header fields and the title type plainly, never paired. | host: phone form | The same. | same: native fields (P214) | none |
| pt-5 | A wikilink being typed (`[[` run open) shows its brackets until the caret leaves it. | host: phone form | The same. | to measure | measure |
