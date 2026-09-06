/**
 * Milkdown round-trip compatibility plugins.
 *
 * A 30,995-note census of the real Milkdown pipeline (docs/plan/
 * milkdown-transition.md §2) found two classes of silent content loss and one
 * corruption class. All three are repaired here, at the layer that causes them:
 *
 * 1. An inline `<br>` — the only legal way to break a line inside a GFM table
 *    cell — is deleted with no replacement, fusing the words on either side.
 *    `@milkdown/preset-commonmark`'s `remarkPreserveEmptyLinePlugin` is
 *    replaced (`./emptyLine`), and the replacement goes further: the preset's
 *    `<br />` stand-in for an empty paragraph is retired altogether, and an
 *    empty paragraph is spelled as an extra blank line in both directions.
 *    `./listItemFiller` is the corollary: the paragraph the schema itself adds
 *    in front of `* > quote` is not written at all.
 * 2. `[](url)` loses its href along with its empty label. A remark transformer
 *    gives the link its URL as visible text (`./emptyLink`).
 * 3. `* 0. item` acquires a literal `<br />`. A pre-parse string pass escapes
 *    the digit-dot (`./bulletNumbers`); this one cannot be a transformer,
 *    because CommonMark has already resolved the ambiguity by then.
 *
 * A fourth upstream plugin is dropped rather than forked:
 *
 * 4. Typing inside a heading comes out REVERSED on WebKit. `syncHeadingIdPlugin`
 *    dispatches a SECOND transaction after every document change, re-stamping
 *    each heading's slug `id` attribute — so a keystroke inside a heading
 *    changes that heading's own markup, ProseMirror cannot update its DOM node
 *    in place (`sameMarkup` is false once an attribute differs) and re-creates
 *    the element the caret is in, mid-typing. WKWebView then puts the NEXT
 *    character at the start of the block: typing `12345` into a heading lands
 *    `# 54321` (measured on the iOS simulator and in Playwright WebKit;
 *    Chromium survives the same churn). Nothing reads heading ids — the
 *    wikilink syntax rejects `[[note#heading]]` — and `headingSchema`'s `toDOM`
 *    still stamps the slug when it creates the element, so a heading rendered
 *    from a note's bytes carries the same anchor id it always did; only a
 *    heading being typed into keeps the id it was created with, which no code
 *    and no rendered output reads. Dropping it also takes a whole-document walk off
 *    every keystroke (AGENTS.md M5).
 *
 * `./atxEscape`, `./underscoreEscape` and `./stringifyHandlers` are the
 * serializer-side members of the same set, from the tag work (#102): remark
 * escapes every line-leading `#`, which destroys a `#tag`, and every `_` in
 * prose, which rewrites `snake_case` and destroys `#dog_problems`.
 *
 * `./frontmatter` is the one member that is an ADDITION rather than a fork: the
 * preset has no front matter construct at all, so `---\ntags: [a, b]\n---`
 * parsed as a thematic break plus a setext heading and the first edit anywhere
 * in the note wrote back `***`, a dash rule, and `tags: \[a, b]` — a changed
 * metadata value. It has no canary to go red, because upstream is not wrong;
 * it just does not ship the extension.
 *
 * These are adapters to one editor library's implementation, not note rules, so
 * they carry no Rust mirror — the M6 carve-out recorded in this package's
 * AGENTS.md. Both native hosts and the census harness consume this module, so
 * there is exactly one definition of what the editor does to a note's bytes.
 *
 * Pinned to `@milkdown/kit` 7.22.1. `milkdown-compat.canary.spec.ts` reproduces
 * each upstream bug against the *unpatched* preset: when upstream fixes one,
 * its canary fails and the corresponding fork here should be deleted.
 */
import {
  commonmark,
  remarkPreserveEmptyLinePlugin,
  syncHeadingIdPlugin,
  syncListOrderPlugin,
} from '@milkdown/kit/preset/commonmark';
import { gfm, keepTableAlignPlugin, tableEditingPlugin } from '@milkdown/kit/preset/gfm';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';

import { bulletNumberEscapePlugin } from './bulletNumbers';
import { remarkExpandEmptyLinksPlugin } from './emptyLink';
import { blankLineJoinPlugin, remarkBlankLineParagraphsPlugin } from './emptyLine';
import { frontmatterPlugins } from './frontmatter';
import { paragraphFillerGuard, paragraphWithoutFillerSchema } from './listItemFiller';
import { scopedListOrderPlugin } from './listOrder';
import { scopedKeepTableAlignPlugin, scopedTableEditingPlugin } from './tablePasses';

export * from './atxEscape';
export * from './stringifyHandlers';
export * from './underscoreEscape';
export { escapeAmbiguousBulletNumbers } from './bulletNumbers';
export { expandEmptyLinks } from './emptyLink';
export { blankLineJoin, fixEmptyLinePlaceholders, restoreBlankLineParagraphs } from './emptyLine';
export {
  FRONTMATTER_CLASS,
  FRONTMATTER_DOC_CONTENT,
  FRONTMATTER_MDAST_TYPE,
  FRONTMATTER_NODE,
} from './frontmatter';
export type { MdastNode } from './mdast';

/** The two entries `remarkPreserveEmptyLinePlugin` contributes to the preset. */
const UPSTREAM_EMPTY_LINE_ENTRIES: readonly unknown[] = [
  remarkPreserveEmptyLinePlugin.options,
  remarkPreserveEmptyLinePlugin.plugin,
];

/** `syncHeadingIdPlugin`'s one entry — removed with no replacement (see 4). */
const UPSTREAM_HEADING_ID_ENTRIES: readonly unknown[] = [syncHeadingIdPlugin];

/**
 * The three preset plugins that walk the WHOLE document on every transaction,
 * each replaced by the same logic over only the top-level blocks the
 * transaction touched (see `./listOrder` and `./tablePasses`). Not a round-trip
 * fix but the same kind of adapter: what a plugin walks is an implementation
 * detail of one editor library, and the per-item rules are kept verbatim.
 *
 * Measured on the low-end Android reference phone at 10k lines (5,000 blocks,
 * `just test-android-perf-quick --profile`, 2026-09-05): `syncListOrderPlugin`'s
 * `doc.descendants` alone was ~12 ms of a 22 ms keystroke, against a 16 ms
 * budget for the whole keystroke (AGENTS.md M5).
 */
const UPSTREAM_LIST_ORDER_ENTRIES: readonly unknown[] = [syncListOrderPlugin];
const UPSTREAM_TABLE_PASS_ENTRIES: readonly unknown[] = [keepTableAlignPlugin, tableEditingPlugin];

/**
 * `plugins` without `entries`.
 *
 * A Milkdown upgrade that changes how the preset is composed makes this throw
 * rather than silently keep the plugin: failing loudly beats shipping an editor
 * that quietly runs a broken plugin next to its replacement, or that never
 * dropped the one it was supposed to drop.
 */
function withoutPresetEntries(
  plugins: MilkdownPlugin[],
  entries: readonly unknown[],
  what: string,
  preset = '@milkdown/preset-commonmark',
): MilkdownPlugin[] {
  const kept = plugins.filter((plugin) => !entries.includes(plugin));
  const removed = plugins.length - kept.length;
  if (removed !== entries.length) {
    throw new Error(
      `milkdown-compat: expected to remove ${entries.length} upstream ${what} entries ` +
        `from the preset, removed ${removed}. ` +
        `Re-check ${preset}'s composition against this module.`,
    );
  }
  return kept;
}

/** The upstream preset minus every plugin this module forks or drops. */
function upstreamPresetWithoutForkedPlugins(): MilkdownPlugin[] {
  const withoutEmptyLine = withoutPresetEntries(
    commonmark as MilkdownPlugin[],
    UPSTREAM_EMPTY_LINE_ENTRIES,
    'empty-line',
  );
  const withoutHeadingId = withoutPresetEntries(
    withoutEmptyLine,
    UPSTREAM_HEADING_ID_ENTRIES,
    'heading-id',
  );
  return withoutPresetEntries(withoutHeadingId, UPSTREAM_LIST_ORDER_ENTRIES, 'list-order');
}

let cached: MilkdownPlugin[] | null = null;
let cachedGfm: MilkdownPlugin[] | null = null;

/**
 * The gfm preset with its two whole-document passes scoped to the blocks a
 * transaction touched — use this in place of `gfm`, and always together with
 * `commonmarkWithCompat()`: both presets' scoped replacements read the same
 * `touchedRange` helpers, and a table pass left running whole-document next to
 * its scoped twin would do the walk twice.
 */
export function gfmWithCompat(): MilkdownPlugin[] {
  cachedGfm ??= [
    ...withoutPresetEntries(
      gfm as MilkdownPlugin[],
      UPSTREAM_TABLE_PASS_ENTRIES,
      'table-pass',
      '@milkdown/preset-gfm',
    ),
    scopedKeepTableAlignPlugin,
    scopedTableEditingPlugin,
  ];
  return cachedGfm;
}

/**
 * The commonmark preset with every round-trip fix applied — use this in place
 * of `commonmark`.
 *
 * Shipped as one array on purpose: filtering the preset without adding the
 * replacement drops every blank line the author typed (see `./emptyLine`), and
 * adding the replacement without filtering leaves the broken plugin running
 * AND brings the `<br />` placeholder back. Neither half is usable alone.
 *
 * A function, not a const, and that matters: this package's barrel re-exports
 * the module, so a preset built at module scope would run its upstream-shape
 * check — and could throw — on any import of `@futo-notes/editor`, and would
 * pull `@milkdown/kit` into every bundle that touches the barrel, including the
 * CodeMirror one and the codegen scripts. A top-level side effect is also not
 * tree-shakeable, so that cost could not be optimized away. Memoized, because
 * the plugin identities have to be stable across editor instances.
 */
export function commonmarkWithCompat(): MilkdownPlugin[] {
  cached ??= [
    ...upstreamPresetWithoutForkedPlugins(),
    ...remarkBlankLineParagraphsPlugin,
    blankLineJoinPlugin,
    /* After the preset (it upserts the preset's `paragraph` by id), and part of
     * the same rule as the two above: without it, the empty paragraph the
     * schema puts in front of `* > quote` would save as a bare `*` line. */
    paragraphWithoutFillerSchema,
    paragraphFillerGuard,
    ...remarkExpandEmptyLinksPlugin,
    bulletNumberEscapePlugin,
    /* The preset's list numbering over the touched blocks only (see
     * UPSTREAM_LIST_ORDER_ENTRIES). */
    scopedListOrderPlugin,
    /* LAST, and it has to be: the front matter set overrides the preset's own
     * `doc` node by re-registering that id, which `$node` resolves by upsert —
     * so it must be registered after the preset, and it reads the registered
     * entry back to inherit everything but the content expression. */
    ...frontmatterPlugins,
  ];
  return cached;
}
