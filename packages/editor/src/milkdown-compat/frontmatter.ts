/**
 * YAML front matter: a block the schema OWNS and never edits.
 *
 * Nothing in `@milkdown/kit`'s commonmark preset recognises front matter, and
 * CommonMark on its own reads the shape as two unrelated constructs: the
 * opening `---` is a thematic break, and the metadata lines followed by the
 * closing `---` are a setext H2. So the first edit anywhere in a note carried
 * three separate harms out to disk (normalize-once, ADR-0002):
 *
 * ```
 * ---                             ***
 * title: Front Matter Test
 * tags: [a, b]          ==>       title: Front Matter Test
 * date: 2026-09-01                tags: \[a, b]
 * ---                             date: 2026-09-01
 *                                 ----------------
 * ```
 *
 * The fence rewrites are ugly. The third is data loss: `tags: [a, b]` became
 * `tags: \[a, b]` — a changed metadata VALUE, because remark-stringify escapes
 * what looks like link syntax in prose (correctly, in prose). Every tool that
 * reads that file's front matter now reads different data. ADR-0002 accepts a
 * normalizing editor re-spelling markdown; it explicitly does not accept losing
 * "constructs the editor's schema doesn't own (raw HTML, wikilinks, footnotes,
 * frontmatter)".
 *
 * The fix is to make front matter a construct the schema DOES own, in three
 * parts:
 *
 * 1. `remark-frontmatter` on the parse and serialize sides, so the block is one
 *    mdast `yaml` node holding its body verbatim rather than a break plus a
 *    heading. It is the standard remark extension for this and it round-trips
 *    the body byte-for-byte — including brackets, hashes, quotes, indentation,
 *    trailing spaces and interior blank lines — because it never looks inside.
 * 2. {@link frontmatterSchema}: an ATOMIC, non-editable ProseMirror block whose
 *    single attribute is that verbatim body. Visible, so a reader knows the
 *    metadata is there and a Backspace from the body cannot silently eat
 *    something invisible; inert, so the editor never offers a caret inside YAML
 *    it has no model for and would have to re-serialize.
 * 3. {@link frontmatterDocSchema}: the doc's content expression, narrowed from
 *    `block+` to `frontmatter? block+`. Front matter is a document-START
 *    construct — a `---` fence anywhere else is a thematic break — so a
 *    document that holds one anywhere else is unrepresentable rather than
 *    merely discouraged. That is what keeps a block reorder or a paste from
 *    producing `body` + `---\ntitle: x\n---`, which the very next open would
 *    read back as a thematic break and a setext heading. (The block-drag path
 *    has its own guard at its single choke point, `blockMove.ts` — ProseMirror
 *    does not enforce content expressions on every transform.)
 *
 * Deliberately NOT done: parsing, validating, or rendering the YAML as fields.
 * The editor has no YAML model, and inventing one is how a metadata value gets
 * "improved". The bytes go in the attribute and come back out.
 *
 * Like the rest of this directory these are adapters to one editor library, not
 * note rules, so they carry no Rust mirror (the M6 carve-out in this package's
 * AGENTS.md). Unlike the rest of the directory, this one is NOT a fork with a
 * canary that should one day die: upstream not shipping front matter is a
 * missing feature, not a bug, and `remark-frontmatter` is the sanctioned way to
 * add it.
 */
import { nodesCtx } from '@milkdown/kit/core';
import { $node, $prose, $remark } from '@milkdown/kit/utils';
import { Plugin as ProsePlugin, Selection } from '@milkdown/kit/prose/state';
import type { NodeSchema } from '@milkdown/kit/transformer';
import type { MarkdownNode, ParserState, SerializerState } from '@milkdown/kit/transformer';
import type { Node as ProseNode, NodeType } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import remarkFrontmatter from 'remark-frontmatter';

/** The ProseMirror node name. */
export const FRONTMATTER_NODE = 'frontmatter';

/** The mdast node type `remark-frontmatter` produces for a `---` block. */
export const FRONTMATTER_MDAST_TYPE = 'yaml';

/**
 * The class on the rendered block, and the hook the shells' stylesheet and the
 * embed specs both reach it by.
 */
export const FRONTMATTER_CLASS = 'futo-frontmatter';

/** Marks our own DOM so a copy/paste round trip through the DOM re-parses. */
const FRONTMATTER_DOM_ATTR = 'data-frontmatter';

/**
 * `remark-frontmatter`, restricted to the `---`-fenced YAML form.
 *
 * The options are explicit rather than defaulted: `$remark` passes `{}` when
 * given no initial options, and `{}` is not a valid matter description. TOML
 * (`+++`) is left out on purpose — this app's notes do not use it, and `+++`
 * already round-trips as the paragraph CommonMark reads it as, so adding it
 * would take an untested construct out of a safe path.
 */
export const remarkFrontmatterPlugin = $remark('futo-frontmatter', () => remarkFrontmatter, [
  'yaml',
]);

/**
 * The front matter block itself.
 *
 * An ATOM with the raw body in `value`, for the same reason the wikilink node is
 * one: display and source deliberately differ (there is no `---` fence in the
 * rendering), so a caret inside the rendering would have no honest position in
 * the source. Rendered as a `<pre>` because the body's newlines and indentation
 * are content, and `contenteditable="false"` because the editor must not invite
 * an edit it would then have to serialize out of a YAML document it cannot read.
 *
 * NOT in `group: 'block'`, which is load-bearing: the doc's narrowed content
 * expression ({@link frontmatterDocSchema}) is only a restriction as long as
 * `block+` cannot admit this node on its own.
 *
 * `selectable: false` is the one that took a measured failure to get right.
 * With it true — the obvious reading of "the user may delete their own
 * metadata" — a single CLICK on the block put a ProseMirror node selection on
 * it, and the very next character replaced it: clicking the metadata and typing
 * left a note whose entire content was that one character. That is exactly the
 * edit the block must not invite. Unselectable, a click resolves to the nearest
 * real text position in the body instead, and ProseMirror's own
 * `Selection.near`/`joinBackward` skip the node rather than joining into it, so
 * a Backspace at the top of the body cannot reach it either. Deleting front
 * matter is still possible the honest way — select the whole note, or edit the
 * file in something that understands YAML.
 */
export const frontmatterSchema = $node(FRONTMATTER_NODE, () => ({
  atom: true,
  selectable: false,
  draggable: false,
  isolating: true,
  attrs: { value: { default: '', validate: 'string' } },
  parseDOM: [
    {
      tag: `pre[${FRONTMATTER_DOM_ATTR}]`,
      preserveWhitespace: 'full' as const,
      getAttrs: (dom: HTMLElement | string) => ({
        value: typeof dom === 'string' ? '' : (dom.textContent ?? ''),
      }),
    },
  ],
  toDOM: (node: ProseNode) => [
    'pre',
    {
      [FRONTMATTER_DOM_ATTR]: '',
      class: FRONTMATTER_CLASS,
      contenteditable: 'false',
      spellcheck: 'false',
      // The rendering has no `---` fences, so say what the block IS. Native
      // hosts read the same DOM through their WebView accessibility trees.
      role: 'note',
      'aria-label': 'Front matter',
    },
    node.attrs.value as string,
  ],
  /** Copy-as-plain-text and `doc.textBetween` get the source syntax back. */
  leafText: (node: ProseNode) => `---\n${node.attrs.value as string}\n---`,
  parseMarkdown: {
    match: ({ type }: MarkdownNode) => type === FRONTMATTER_MDAST_TYPE,
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      state.addNode(type, { value: (node.value as string | undefined) ?? '' });
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === FRONTMATTER_NODE,
    runner: (state: SerializerState, node: ProseNode) => {
      state.addNode(FRONTMATTER_MDAST_TYPE, undefined, node.attrs.value as string);
    },
  },
}));

/**
 * A tap or click on the block puts the caret at the top of the BODY.
 *
 * Without this the block is a dead spot that still looks live: it is
 * `contenteditable="false"` and unselectable, so a tap focuses the editor and
 * raises the keyboard and then the first character goes nowhere. Measured on
 * the iOS simulator — tapping the panel and typing `X` left the file untouched,
 * while the same tap on the body wrote it — and the panel sits at the very top
 * of the note, which is exactly where a reader taps first.
 *
 * Placing the caret after the node is also the only answer that cannot lose
 * anything: there is no position INSIDE an atom, and putting a selection ON it
 * is the thing `selectable: false` exists to prevent.
 */
export const frontmatterClickPlugin = $prose(
  () =>
    new ProsePlugin({
      props: {
        handleClickOn: (
          view: ProseView,
          _pos: number,
          node: ProseNode,
          nodePos: number,
        ): boolean => {
          if (node.type.name !== FRONTMATTER_NODE) return false;
          const after = Selection.near(view.state.doc.resolve(nodePos + node.nodeSize), 1);
          view.dispatch(view.state.tr.setSelection(after).scrollIntoView());
          return true;
        },
      },
    }),
);

const DOC_NODE = 'doc';

/** The content expression `@milkdown/preset-commonmark@7.22.1`'s doc ships. */
const UPSTREAM_DOC_CONTENT = 'block+';

/** What it becomes: front matter first, at most once, or not at all. */
export const FRONTMATTER_DOC_CONTENT = `${FRONTMATTER_NODE}? ${UPSTREAM_DOC_CONTENT}`;

/**
 * The upstream `doc` node with its content expression narrowed to
 * {@link FRONTMATTER_DOC_CONTENT}.
 *
 * Registered by the SAME id as upstream's, which is how `$node` replaces it:
 * it upserts `nodesCtx` by id, and this plugin is ordered after the preset in
 * {@link ../index.commonmarkWithCompat}. Everything else about the node —
 * notably its `parseMarkdown`/`toMarkdown` runners, which own `injectRoot` —
 * is read back off the registered entry and passed through, so an upstream
 * change to any of it is inherited rather than forked away.
 *
 * The one thing that cannot be inherited is the content expression, so that one
 * is asserted: a Milkdown upgrade that changes it makes this throw at editor
 * creation rather than silently discarding upstream's new expression.
 */
export const frontmatterDocSchema = $node(DOC_NODE, (ctx) => {
  const registered = ctx.get(nodesCtx).find(([id]) => id === DOC_NODE);
  if (!registered) {
    throw new Error(
      `milkdown-compat: no '${DOC_NODE}' node registered before the front matter override. ` +
        'It must come after the commonmark preset in commonmarkWithCompat().',
    );
  }
  const upstream: NodeSchema = registered[1];
  if (upstream.content !== UPSTREAM_DOC_CONTENT) {
    throw new Error(
      `milkdown-compat: expected the commonmark preset's '${DOC_NODE}' content to be ` +
        `'${UPSTREAM_DOC_CONTENT}', found '${String(upstream.content)}'. ` +
        "Re-check @milkdown/preset-commonmark's docSchema against this module.",
    );
  }
  return { ...upstream, content: FRONTMATTER_DOC_CONTENT };
});

/**
 * All three parts, in the order they must load: the remark extension, the node,
 * then the doc override (which reads the node name and the registered doc).
 */
export const frontmatterPlugins = [
  ...remarkFrontmatterPlugin,
  frontmatterSchema,
  frontmatterClickPlugin,
  frontmatterDocSchema,
];
