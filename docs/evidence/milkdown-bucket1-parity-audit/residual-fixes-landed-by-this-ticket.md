## Residual fixes landed by this ticket

1. **Enter in a table cell inserts a row below** (last row appends; header row inserts the first
   body row; caret follows to the same column). Was: `exitTable` + a stray paragraph; on the
   native shells there was NO way to add a row. src/features/editor/milkdown/keyboardParity.ts,
   wired as the `handleKeyDown` direct view prop.
2. **Tab at the very last cell appends a row** instead of tabbing focus out of the editor and
   swallowing subsequent typing.
3. **Splitting a checked task item starts the new item unchecked** (CM6 `listContinuation`
   parity; the default split cloned `checked: true`).
4. **An empty table cell serializes as `|  |`**, not `| <br /> |`
   (packages/editor/src/milkdown-compat/emptyLine.ts `htmlWithoutEmptyCellPlaceholder`). Also
   repairs a pre‑existing corruption: any note holding an empty cell had it rewritten to
   `| <br /> |` by the first unrelated keystroke. Full-corpus census `--diff`: 339 cleared,
   **0 newly raised** over 30,995 notes. It replaces the stock remark‑stringify `html` handler,
   which is exactly `node.value || ''` with `peek() === '<'` — verified against
   `mdast-util-to-markdown/lib/handle/html.js`, and nothing in Milkdown or this repo installs a
   custom one — so everything the handler does not claim serializes identically.
5. **Flake hardening**: the formatState bold assertion now polls for the settled state instead of
   reading the first message after a click (tests/editor-embed-milkdown.spec.ts).

Regression coverage: 14 unit tests (keyboardParity.test.ts), 5 handler tests
(emptyLine.test.ts), 14 bundle‑seam tests (editor-embed-milkdown-interactive.spec.ts).

**Red‑proof (the coverage is load‑bearing, not decorative).** Each fix was patched back out of
`MilkdownEditor.svelte` and the bundle‑seam suite re‑run against the rebuilt bundle, so the
tests are known to fail for the stated reason rather than passing vacuously (AGENTS.md 7.9):

| Bundle state | Result |
|---|---|
| Both fixes present | 14 passed |
| Both fixes removed | **6 failed**, 8 passed |
| `handleKeyDown` restored, serializer handler still out | **5 failed**, 9 passed |

The third row is the one that matters for the serializer fix: it fails independently of the
keyboard fix, because the empty cell in the newly appended row serializes as `| <br /> |`
without the handler. The 8 tests that stay green in row 2 are the ones marked "PASS (locked
this run)" — they lock pre‑existing behavior, so staying green with the fixes removed is the
correct outcome for them.
