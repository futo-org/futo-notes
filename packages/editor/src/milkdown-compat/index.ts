/**
 * Milkdown round-trip compatibility plugins, and the editor's own serializer.
 *
 * WRITING. Every byte the editor writes comes out of the owned serializer
 * (`../markdown`, #266, house style in docs/spec/editor.md), which
 * `./ownedSerializer` installs as Milkdown's `serializerCtx`. Milkdown's
 * remark-stringify serializer is never called, so nothing here patches it.
 *
 * READING. A 30,995-note census of the real Milkdown pipeline (docs/plan/
 * milkdown-transition.md §2) found two classes of silent content loss and one
 * corruption class on the way in. All three are repaired here, at the layer
 * that causes them:
 *
 * 1. An inline `<br>` — the only legal way to break a line inside a GFM table
 *    cell — is deleted with no replacement, fusing the words on either side.
 *    `@milkdown/preset-commonmark`'s `remarkPreserveEmptyLinePlugin` is
 *    replaced (`./emptyLine`), and the replacement goes further: the preset's
 *    `<br />` stand-in for an empty paragraph is retired altogether, and blank
 *    lines read back as the empty paragraphs the serializer writes them for.
 * 2. `[](url)` loses its href along with its empty label. A remark transformer
 *    gives the link its URL as visible text (`./emptyLink`).
 * 3a. A title-less `![alt](src)` parses to `title: null`, which the preset's own
 *    image schema rejects; `./imageTitle` gives it the empty string.
 * 3b. An EMPTY task item has no text for GFM's `[ ]` marker to be followed by,
 *    so `- [ ]` parsed as a bullet holding the literal text `[ ]`.
 *    `./emptyTaskItem` reads it as the empty task item the serializer wrote.
 * Ambiguous bullet contents use CommonMark's interpretation.
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
 * One more fork is not a round-trip fix but an input one (FB-19, L6f-2):
 * `./inlineNodesCursor` replaces `inlineNodesCursorPlugin`, whose
 * `compositionend` handler claimed the event and so kept ProseMirror from ever
 * ending an IME composition that committed between two non-text inline nodes
 * (two wikilink chips, an image and a chip). `view.composing` stayed set: `- `
 * stopped making a list and the host's `isComposing()` stuck true.
 *
 * From the 2026-09 hardening campaign: `./inlineHtmlIndent` gives a multi-line
 * inline HTML tag back the continuation indent the parser strips, which
 * otherwise shrank every save; `./linkDefinitions` keeps a link reference
 * definition nothing uses (upstream deleted every one); `./tableWidth` pads a
 * ragged table at the end rather than letting `fixTables` shift its rows;
 * `./tableAlignment` keeps a cell's missing alignment through a paste; and
 * `./listItemSpread` makes an item the editor creates tight.
 *
 * `./frontmatter` is the one member that is an ADDITION rather than a fork: the
 * preset has no front matter construct at all, so `---\ntags: [a, b]\n---`
 * parsed as a thematic break plus a setext heading and the first edit anywhere
 * in the note rewrote the metadata. It has no canary to go red, because
 * upstream is not wrong; it just does not ship the extension.
 *
 * These are adapters to one editor library's implementation, not note rules, so
 * they carry no Rust mirror — the M6 carve-out recorded in this package's
 * AGENTS.md. Both native hosts and the census harness consume this module, so
 * there is exactly one definition of what the editor does to a note's bytes.
 *
 * Pinned to `@milkdown/kit` 7.22.1. `tests/editor-embed-milkdown-compat.spec.ts`
 * reproduces each upstream bug against the *unpatched* preset: when upstream
 * fixes one, its canary fails and the corresponding fork here should be deleted.
 */
import {
  commonmark,
  inlineNodesCursorPlugin as upstreamInlineNodesCursorPlugin,
  remarkInlineLinkPlugin,
  remarkPreserveEmptyLinePlugin,
  syncHeadingIdPlugin,
  syncListOrderPlugin,
} from '@milkdown/kit/preset/commonmark';
import { gfm, keepTableAlignPlugin, tableEditingPlugin } from '@milkdown/kit/preset/gfm';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';

import { remarkExpandEmptyLinksPlugin } from './emptyLink';
import { remarkInlineHtmlIndentPlugin } from './inlineHtmlIndent';
import { remarkEmptyTaskItemPlugin } from './emptyTaskItem';
import { remarkImageTitlePlugin } from './imageTitle';
import { inlineNodesCursorPlugin } from './inlineNodesCursor';
import { remarkInlineUsedLinkDefinitionsPlugin } from './linkDefinitions';
import { remarkBlankLineParagraphsPlugin } from './emptyLine';
import { frontmatterPlugins } from './frontmatter';
import { scopedListOrderPlugin } from './listOrder';
import { tightListItemSchema } from './listItemSpread';
import { ownedSerializerPlugin } from './ownedSerializer';
import { scopedKeepTableAlignPlugin, scopedTableEditingPlugin } from './tablePasses';
import { tableAlignmentSchemas } from './tableAlignment';
import { remarkPadTableRowsPlugin } from './tableWidth';

export { expandEmptyLinks } from './emptyLink';
export { markEmptyTaskItems } from './emptyTaskItem';
export { defaultImageTitles } from './imageTitle';
export { fixEmptyLinePlaceholders, restoreBlankLineParagraphs } from './emptyLine';
export {
  FRONTMATTER_CLASS,
  FRONTMATTER_DOC_CONTENT,
  FRONTMATTER_MDAST_TYPE,
  FRONTMATTER_NODE,
} from './frontmatter';
export type { MdastNode } from './mdast';
export { editorMarkdownSerializer, ownedSerializerPlugin } from './ownedSerializer';
export { hasSurplusTrailingEmptyParagraphs } from './trailingParagraph';

/** The two entries `remarkPreserveEmptyLinePlugin` contributes to the preset. */
const UPSTREAM_EMPTY_LINE_ENTRIES: readonly unknown[] = [
  remarkPreserveEmptyLinePlugin.options,
  remarkPreserveEmptyLinePlugin.plugin,
];

/** `remarkInlineLinkPlugin`'s two entries — replaced by `./linkDefinitions`. */
const UPSTREAM_INLINE_LINK_ENTRIES: readonly unknown[] = [
  remarkInlineLinkPlugin.options,
  remarkInlineLinkPlugin.plugin,
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

/**
 * `plugins` with `upstream` swapped for `replacement` at the same index — for a
 * fork whose position matters: where a `handleDOMEvents` plugin sits in the
 * list decides which of two plugins claims an event first. Throws, like
 * `withoutPresetEntries`, when the preset no longer holds `upstream`.
 */
function replacePresetEntry(
  plugins: MilkdownPlugin[],
  upstream: MilkdownPlugin,
  replacement: MilkdownPlugin,
  what: string,
): MilkdownPlugin[] {
  const at = plugins.indexOf(upstream);
  if (at < 0) {
    throw new Error(
      `milkdown-compat: expected to replace the upstream ${what} entry in the preset, ` +
        `found none. Re-check @milkdown/preset-commonmark's composition against this module.`,
    );
  }
  return plugins.map((plugin, index) => (index === at ? replacement : plugin));
}

/** The upstream preset minus every plugin this module forks or drops. */
function upstreamPresetWithoutForkedPlugins(): MilkdownPlugin[] {
  const withoutEmptyLine = withoutPresetEntries(
    commonmark as MilkdownPlugin[],
    UPSTREAM_EMPTY_LINE_ENTRIES,
    'empty-line',
  );
  const withoutInlineLink = withoutPresetEntries(
    withoutEmptyLine,
    UPSTREAM_INLINE_LINK_ENTRIES,
    'inline-link',
  );
  const withoutHeadingId = withoutPresetEntries(
    withoutInlineLink,
    UPSTREAM_HEADING_ID_ENTRIES,
    'heading-id',
  );
  const withoutListOrder = withoutPresetEntries(
    withoutHeadingId,
    UPSTREAM_LIST_ORDER_ENTRIES,
    'list-order',
  );
  return replacePresetEntry(
    withoutListOrder,
    upstreamInlineNodesCursorPlugin,
    inlineNodesCursorPlugin,
    'inline-cursor',
  );
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
    /* Ragged rows squared up at the end, before `fixTables` can pad them at
     * the start (see `./tableWidth`). */
    ...remarkPadTableRowsPlugin,
    /* After the preset, whose cell nodes they re-register: a cell with no
     * alignment keeps none through a paste (see `./tableAlignment`). */
    ...tableAlignmentSchemas,
    /* After the preset, whose task-list support extends `list_item`: an item the
     * editor makes is tight, like one read from a tight file (see `./listItemSpread`). */
    tightListItemSchema,
  ];
  return cachedGfm;
}

/**
 * The commonmark preset with every round-trip fix applied, writing through the
 * editor's own serializer — use this in place of `commonmark`.
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
    /* After the blank-line restore, which counts gaps by source line: a used
     * definition deleted before it left its lines behind as empty paragraphs. */
    ...remarkInlineUsedLinkDefinitionsPlugin,
    ...remarkExpandEmptyLinksPlugin,
    ...remarkInlineHtmlIndentPlugin,
    ...remarkImageTitlePlugin,
    ...remarkEmptyTaskItemPlugin,
    /* The preset's list numbering over the touched blocks only (see
     * UPSTREAM_LIST_ORDER_ENTRIES). */
    scopedListOrderPlugin,
    /* After the preset, and it has to be: the front matter set overrides the
     * preset's own `doc` node by re-registering that id, which `$node` resolves
     * by upsert — so it must be registered after the preset, and it reads the
     * registered entry back to inherit everything but the content expression. */
    ...frontmatterPlugins,
    /* Every byte the editor writes (`./ownedSerializer`). */
    ownedSerializerPlugin,
  ];
  return cached;
}
