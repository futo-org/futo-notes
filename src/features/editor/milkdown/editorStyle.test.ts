import { readFileSync } from 'node:fs';
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
 * `MilkdownEditor.svelte` now spells this as two same-specificity rules
 * (`> *` plus a `:where(:first-child)` override) instead — this test is the
 * guard against that regressing, here or in any other editor selector scoped
 * under `.ProseMirror`/`.milkdown`/`.futo-milkdown`.
 */

const MILKDOWN_EDITOR_SVELTE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'MilkdownEditor.svelte',
);

/** A bare universal adjacent- or general-sibling combinator: `* + *` / `* ~ *`. */
const UNIVERSAL_SIBLING_COMBINATOR_RE = /\*\s*[+~]\s*\*/;

function extractStyleBlock(source: string): string {
  const match = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source);
  if (!match) throw new Error('MilkdownEditor.svelte has no <style> block to check');
  return match[1] ?? '';
}

/** Every selector text (the part before `{`), with CSS comments stripped first. */
function extractSelectors(styleBlock: string): string[] {
  const withoutComments = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{/g)].map((m) => (m[1] ?? '').trim());
}

describe('MilkdownEditor.svelte style block', () => {
  it('never re-introduces a universal sibling combinator scoped to the editor', () => {
    const source = readFileSync(MILKDOWN_EDITOR_SVELTE, 'utf8');
    const selectors = extractSelectors(extractStyleBlock(source));
    const offenders = selectors.filter((selector) =>
      UNIVERSAL_SIBLING_COMBINATOR_RE.test(selector),
    );
    expect(offenders).toEqual([]);
  });
});
