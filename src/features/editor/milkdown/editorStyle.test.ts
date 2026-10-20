import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `.futo-milkdown .ProseMirror > * + *` (the previous block-spacing rule) cost
 * a streamed 10k-line open ~16.4 s of `UpdateLayoutTree` alone (2026-09-08
 * device trace): Chromium cannot scope invalidation for a universal
 * adjacent-sibling selector, so every child insert/remove under `.ProseMirror`
 * invalidates the root's WHOLE SUBTREE, with an elementCount that grew with
 * the document (3,056 → 5,682 → … → 39,816) — twice per streamed chunk, and on
 * every Enter/Backspace that adds or removes a block. The 25k fixture never
 * completed the harness's 180 s budget at all (it used to finish in 36 s).
 * `milkdownEditor.css` now spells this as two same-specificity rules
 * (`> *` plus a `:where(:first-child)` override) instead — this test is the
 * guard against that regressing, here or in any other editor selector scoped
 * under `.ProseMirror`/`.milkdown`/`.futo-milkdown`.
 */

const MILKDOWN_DIR = path.dirname(fileURLToPath(import.meta.url));
/** `milkdownEditor.css` and the parts it `@import`s, which share its cascade. */
const MILKDOWN_EDITOR_CSS = readdirSync(MILKDOWN_DIR)
  .filter((name) => /^milkdownEditor(\.[a-z]+)?\.css$/.test(name))
  .map((name) => path.join(MILKDOWN_DIR, name));

/** A bare universal adjacent- or general-sibling combinator: `* + *` / `* ~ *`. */
const UNIVERSAL_SIBLING_COMBINATOR_RE = /\*\s*[+~]\s*\*/;

/** Every selector text (the part before `{`), with CSS comments stripped first. */
function extractSelectors(styleBlock: string): string[] {
  const withoutComments = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{/g)].map((m) => (m[1] ?? '').trim());
}

describe('milkdownEditor.css', () => {
  it('never re-introduces a universal sibling combinator scoped to the editor', () => {
    expect(MILKDOWN_EDITOR_CSS).toHaveLength(3);
    const selectors = MILKDOWN_EDITOR_CSS.flatMap((file) =>
      extractSelectors(readFileSync(file, 'utf8')),
    );
    const offenders = selectors.filter((selector) =>
      UNIVERSAL_SIBLING_COMBINATOR_RE.test(selector),
    );
    expect(offenders).toEqual([]);
  });
});
