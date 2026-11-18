# Images (`im`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/images.md`. Ruling: Android keeps its own image drawing; measure Mason's rules (im-5, im-9, im-10). Adding an image by paste is deferred on desktop too: no row.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| im-1 | Draws an image as an inline block on its row's bottom; a wide one wraps to its own row. | Android's earlier decision | Android keeps its own drawing (ruling). | inline, never wider than the line (mobile/images.md) | none |
| im-2 | Caps a picture at the column's width and 300px tall, 6px corners. | Android's earlier decision | Android keeps its own drawing (ruling). | own sizes | none |
| im-3 | A tall picture makes its row that tall; caret, highlight and taps measure it so. | Android's earlier decision | Android keeps its own drawing (ruling). | own layout | none |
| im-4 | Resolves a vault image for display only; loads pictures within a screen of view. | host: phone form | The same. | loads from the vault root, off the main thread (mobile/images.md) | none |
| im-5 | A picture that will not load shows its alt or file name as a muted label you can select and delete. | host: phone form | The same. | to measure | measure |
| im-6 | A loaded picture redraws the caret; one above the view keeps the text still. | Android's earlier decision | Android keeps its own drawing (ruling). | own drawing | none |
| im-7 | The caret stops only before and after an image. | engine | images.md (atom stops). | same (mobile/images.md) | none |
| im-8 | A click on a picture selects the image whole. | Android's earlier decision | Android's tap puts the caret after the image (its own drawing). | same (mobile/images.md) | none |
| im-9 | Tints a selected picture with the selection colour. | host: phone form | The same. | to measure | measure |
| im-10 | Backspace right after an image, or Delete right before it, selects it; the next press deletes it. | host: phone form | Soft-keyboard Backspace; hardware Delete. | Backspace after it removes it at once (mobile/images.md) | measure |
| im-11 | Enter with exactly an image selected keeps it and opens a line after it. | engine | images.md; the host keeps the keyboard's collapse-and-delete away. | to measure | measure |
| im-12 | Copies an image as its Markdown spelling. | engine | The engine's copy. | same | none |
