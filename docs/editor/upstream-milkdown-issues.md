# Upstream Milkdown issues

Two of the three defects `packages/editor/src/milkdown-compat/` works around are
Milkdown bugs and belong upstream (github.com/Milkdown/milkdown). The third —
the spurious `<br />` on `* 0.`-style bullets — is CommonMark behaving as
specified, so there is nothing to file.

**Status: drafted, NOT yet filed.** Filing is an outward-facing post under the
FUTO name, so it waits on Justin. When each is filed, replace its status line
with the issue URL, and put that URL in the matching canary test in
`tests/editor-embed-milkdown-compat.spec.ts`.

Reproduced against `@milkdown/kit` 7.22.1 in headless Chromium; every claim
below is what `tests/milkdown-census` measured over 30,995 real notes.

---

## Issue 1 — `remarkPreserveEmptyLinePlugin` deletes inline `<br>` with no replacement

**Status:** not yet filed.

### What happens

An inline `<br>` — the only legal way to break a line inside a GFM table cell,
and a common manual line break in prose — is deleted from the document on parse,
with no replacement. The words on either side fuse together.

```js
import { Editor, defaultValueCtx, rootCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { getMarkdown } from '@milkdown/kit/utils'

const editor = await Editor.make()
  .config((ctx) => {
    ctx.set(rootCtx, document.body)
    ctx.set(defaultValueCtx, 'sentence one.<br>sentence two.\n')
  })
  .use(commonmark)
  .create()

editor.action(getMarkdown())
// actual:   'sentence one.sentence two.\n'
// expected: 'sentence one.<br>sentence two.\n'
```

In a table (with `@milkdown/kit/preset/gfm`):

```
IN : | a | b |
     | --- | --- |
     | sentence one.<br>sentence two. | x |

OUT: | a                          | b |
     | -------------------------- | - |
     | sentence one.sentence two. | x |
```

The `<br>` never reaches the ProseMirror document at all, so this is not the
`html` node schema — that schema is fine, and `<kbd>`, HTML comments and every
other inline tag round-trip perfectly.

### Where it comes from

`packages/preset-commonmark/src/plugin/remark-preserve-empty-line.ts`.
`visitEmptyLine` deletes **any** mdast `html` node whose trimmed value is one of
`<br />`, `<br>`, `<br >`, `<br/>`, with no check on where the node sits:

```ts
return visitParents(
  ast,
  (node) => node.type === 'html' && ['<br />', '<br>', '<br >', '<br/>'].includes(node.value?.trim()),
  (node, parents) => { /* splice it out of its parent */ },
  true,
)
```

The plugin's actual job is to consume the placeholder `node/paragraph.ts`'s
`toMarkdown` emits for a non-final empty paragraph, so a blank line survives a
round trip. That placeholder is always in *block* position — a direct child of
`root`, `listItem`, `blockquote` or `footnoteDefinition`, or the sole child of a
`paragraph`/`tableCell`. An author's inline `<br>` never is.

### Suggested fix

Narrow the predicate to the position the placeholder actually occupies. In our
fork that is: delete when the parent is `root`, `blockquote`, `listItem` or
`footnoteDefinition`, or when the parent is a `paragraph`/`tableCell` whose only
child is the node. Unknown parent types default to keeping the node, since a
stray visible `<br />` is cosmetic and a deleted line break is data loss.

We are happy to open a PR if the shape looks right.

### Impact

63 of 30,995 real notes in our corpus lose content to this. It is silent,
deterministic, and happens on open — before the user types anything.

---

## Issue 2 — an empty-label link `[](url)` is deleted, href and all

**Status:** not yet filed.

### What happens

```js
ctx.set(defaultValueCtx, '## heading\n\n[](api-plan.md)\n')
// getMarkdown() → '## heading\n\n'
```

The URL is gone from the document entirely — this is not "the link lost its
styling", the destination is unrecoverable.

### Where it comes from

`packages/preset-commonmark/src/mark/link.ts`'s `parseMarkdown.runner` does
`state.next(node.children)`. mdast gives an empty-label link an empty `children`
array, so that call adds nothing to the document. A link is a ProseMirror
**mark**, and a mark needs content to attach to, so nothing is ever created to
carry the href.

### Suggested fix

When a `link` node has no children, add a text child equal to the URL before
running the mark — the same normalization remark's own inline-link handling
already applies elsewhere, and it keeps the destination visible and editable.
Anything is better than dropping it; even emitting the raw `[](url)` as text
would preserve the information.

### Impact

Rarer than issue 1 (27 notes of 30,995), but the same category: silent,
deterministic loss on open.
