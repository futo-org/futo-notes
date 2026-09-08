/**
 * A per-top-level-block serialization cache for Milkdown's markdown output.
 *
 * The problem: `readSerialized()` in MilkdownEditor.svelte calls Milkdown's
 * `getMarkdown()` on the WHOLE document 200 ms after every settled edit
 * (documentChanges.ts). That is proportional to document size, not to the
 * edit, and at 12,500 top-level blocks it is ~10 s on the main thread on the
 * reference phone (docs/plan/milkdown-transition.md "Gate run, real app,
 * 2026-09-06"). This module makes it proportional to the edit instead, by
 * caching each top-level block's own markdown text keyed on ProseMirror node
 * IDENTITY — an unchanged block keeps the exact same `ProseNode` object across
 * a transaction, so a WeakMap hit costs nothing to check.
 *
 * WHY A "UNIT" IS NOT ALWAYS ONE NODE, AND WHY THE SPLIT IS EXACT (confirmed
 * by reading the actual libraries this editor ships, not assumed):
 *
 * Milkdown's serializer (`@milkdown/transformer`'s `SerializerState`) turns
 * the ProseMirror doc into an mdast `root` and hands it to
 * `mdast-util-to-markdown`'s `toMarkdown`. `toMarkdown` calls the `root`
 * handler (`lib/handle/root.js`), which for a block-only document is
 * `state.containerFlow` (`lib/util/container-flow.js`):
 *
 *   - Every child is serialized with the SAME `{ before: '\n', after: '\n' }`
 *     info regardless of position — so a child's own markdown text is
 *     independent of its siblings.
 *   - Between two children, `between()` asks `state.join` (iterated from the
 *     END of the array, i.e. the LAST-registered handler runs first) for a
 *     separator, falling back to `'\n\n'` (a blank line) if every handler
 *     returns `undefined`. `mdast-util-to-markdown`'s own `join.js` installs
 *     exactly one default (`joinDefaults`), which only fires for indented
 *     code after a list/indented-code sibling (this editor fences all code
 *     blocks — see `code_block: { code: true }` and the fenced serializer, so
 *     `formatCodeAsIndented` never matches) or when `parent` carries a
 *     `spread` field (only list/listItem parents do; the document root does
 *     not). Neither applies at the top level.
 *   - `mdast-util-to-markdown@2.1.2`'s `configure()` appends caller-supplied
 *     `options.join` entries onto the base `[joinDefaults]` array with
 *     `Array.prototype.push`, and `between()` walks `state.join` back-to-front
 *     — so a caller-supplied join handler is always tried BEFORE
 *     `joinDefaults`. This package registers exactly one:
 *     `blankLineJoin` (packages/editor/src/milkdown-compat/emptyLine.ts),
 *     installed once by `blankLineJoinPlugin`. Grepping every
 *     `milkdown-compat/*.ts` file and both presets'
 *     (`@milkdown/preset-commonmark`, `@milkdown/preset-gfm`) built output for
 *     `join` confirms no other handler is ever installed.
 *   - `containerFlow` also threads exactly one piece of cross-child state:
 *     `state.bulletLastUsed`. It is cleared to `undefined` after every
 *     non-list child (including an empty paragraph) and read by the `list`
 *     handler (`lib/handle/list.js`) to alternate the bullet marker of a list
 *     that immediately follows another list. `blankLineJoin` carries that
 *     value FORWARD across a run of intervening empty paragraphs
 *     (`bulletBeforeEmptyParagraphs`), which is precisely why `list, empty,
 *     list` must alternate as if the empty paragraphs were not there — and
 *     why such a run has to serialize as ONE unit rather than three.
 *   - `toMarkdown` (`lib/index.js`) appends exactly one trailing `\n` to its
 *     result, and only if the result is non-empty and does not already end in
 *     `\n` or `\r`.
 *
 * `list.js`'s other marker-alternation cases (an empty first list item, or a
 * thematic break, at the start of a list nested two levels inside two other
 * lists) key off `state.stack`/`indexStack`, which describe ANCESTRY, not
 * root-level siblings — unaffected by where a unit's boundary falls, since
 * every unit here is a top-level child of the document either way.
 *
 * TWO WAYS A NODE'S TEXT CAN DEPEND ON A SIBLING (found by a 30,995-note
 * `--serialize` census against a FIRST version of this module that only knew
 * about a `list (emptyParagraph* list)*` run — 19 divergences, two root
 * causes, both now covered by `partitionUnits` below and both re-verified
 * directly against the real `mdast-util-to-markdown` + `blankLineJoin`
 * sources, not just reasoned about):
 *
 *   1. DIRECT, ONE HOP: `containerFlow` clears `state.bulletLastUsed` to
 *      `undefined` right after handling a child whose type is not `'list'` —
 *      but that reset happens AFTER the child is handled, so if the child
 *      itself is a container (a blockquote, list_item, or footnote_definition
 *      — anything that recurses into ITS OWN `containerFlow` for its own
 *      children), that inner call still sees whatever `bulletLastUsed` the
 *      PRECEDING sibling left behind. A list directly followed by a
 *      blockquote whose first child is itself a list therefore has that inner
 *      list alternate against the OUTER list's bullet (11 of the 19 notes).
 *      Bounded to exactly one hop — the very next sibling — because the reset
 *      always fires immediately afterward regardless of what that sibling
 *      contains.
 *   2. INDIRECT, ARBITRARY RANGE: `blankLineJoin`'s own `bulletBeforeEmptyParagraphs`
 *      WeakMap (packages/editor/src/milkdown-compat/emptyLine.ts) is SET when
 *      a list is followed by an empty paragraph, and is deleted ONLY when a
 *      later join sees BOTH sides non-empty — read the function: the delete
 *      sits after an `isEmptyParagraph(left)` early return, so any pair where
 *      EITHER side is an empty paragraph leaves a live entry untouched. It is
 *      then read (restored into `bulletLastUsed`) by the NEXT `(empty, list)`
 *      pair, however many leaf siblings (headings, paragraphs, more empty
 *      paragraphs) sit in between. `list, empty, heading, empty, list`
 *      therefore alternates the second list's bullet even though a heading
 *      separates them (8 of the 19 notes) — confirmed by feeding
 *      `mdast-util-to-markdown`'s real `toMarkdown` this exact shape directly
 *      (bypassing ProseMirror/Milkdown entirely) and diffing whole-document
 *      output against every candidate partitioning; only a grouping that
 *      keeps the SET node and the RESTORE node in one `serializeDoc()` call
 *      reproduces the real bytes — a version that split at every LEAF sibling
 *      in between (matching the literal shape of a first draft of this rule)
 *      measurably produced the WRONG bullet. Also conservative: a container
 *      (blockquote, footnote_definition, an unrecognized node) whose OWN
 *      un-inspected internals might end in `list, empty` can leave the map set
 *      when it returns, so `partitionUnits` treats "primed the entry" as ANY
 *      non-leaf predecessor, not just a literal list — verified that the
 *      RESTORE side does NOT need the same widening (a container's inner list
 *      does not inherit a restore through it; only a literal sibling `list`
 *      node does, matching `right?.type === 'list'` in the real code).
 *
 * `partitionUnits` is a two-pass simulation over the top-level children:
 *
 *   - Pass 1 (case 1, single hop): for each adjacent pair, if the left node is
 *     a list and the right node is not a LEAF (paragraph, heading, code_block,
 *     hr, table, html, image, the frontmatter node — everything else,
 *     including blockquote/list/footnote_definition/anything unrecognized,
 *     is conservatively NOT a leaf), that pair may never be split.
 *   - Pass 2 (case 2, the WeakMap span): replay the SAME set/restore/clear
 *     transitions `blankLineJoin` uses, tracking `liveSince` — the index of
 *     the node that (last, while unresolved) primed the entry, or `null`. On
 *     a genuine RESTORE (an empty left, a literal list right, and a live
 *     entry), every gap from `liveSince` through the restoring pair is
 *     retroactively forced open — the only way the restoring unit can
 *     reproduce the true bytes is if the priming node is physically present
 *     in the SAME `serializeDoc()` call. `liveSince` is STICKY: a later SET
 *     while already live does not move it forward, because whatever
 *     eventually consumes the current value will force a merge back to the
 *     ORIGINAL priming node anyway, and that span already covers everything
 *     in between. Over-merging here is always safe — a unit's own text is
 *     unaffected by which OTHER nodes happen to share its `serializeDoc()`
 *     call, so grouping more than the minimum required costs cache
 *     granularity, never correctness (this is also why "conservative" leaf
 *     classification above is safe, and why a stray un-consumed live entry at
 *     the end of a unit's run, with nothing left to restore it, is harmless).
 *
 * Each resulting unit is then serialized in an isolated one-off document (so
 * it starts with a clean, unset `bulletLastUsed`/WeakMap — exactly the state
 * that real position would have, since a unit boundary is only ever placed
 * where the map is provably not live), the one trailing `\n` `toMarkdown`
 * adds to a non-empty result is stripped, and units are rejoined: `'\n'`
 * between two units when the LEFT unit's LAST node is an empty paragraph (the
 * exact condition `blankLineJoin` uses for that specific pair), `'\n\n'`
 * otherwise, with the final trailing `\n` re-appended if the whole is
 * non-empty and does not already end in `\n`/`\r`.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { FRONTMATTER_NODE } from '@futo-notes/editor/milkdown-compat';

/** What the cache needs to turn a set of top-level nodes into markdown. */
export interface BlockSerializerDeps {
  /** Milkdown's serializer for a doc node: `editor.ctx.get(serializerCtx)`. */
  serializeDoc: (doc: ProseNode) => string;
  /** Builds a doc holding exactly these top-level nodes: `schema.topNodeType.create(null, nodes)`. */
  createDoc: (nodes: ProseNode[]) => ProseNode;
}

export interface BlockSerializer {
  /** Whole-document markdown, byte-equal to Milkdown's getMarkdown(). Fills cache misses synchronously. */
  serialize(doc: ProseNode): string;
  /** True when every unit of `doc` is cached (serialize() would do no serialization work). */
  isPrimed(doc: ProseNode): boolean;
  /** Serializes uncached units while `timeRemainingMs()` > 0 (at least one per call). Returns true when `doc` is fully primed. */
  prime(doc: ProseNode, timeRemainingMs: () => number): boolean;
}

/** The two node type names the shipping schema uses for a markdown list (`bullet_list`, `ordered_list`). */
function isListNode(node: ProseNode): boolean {
  return node.type.name === 'bullet_list' || node.type.name === 'ordered_list';
}

/** A `paragraph` node with no content — this editor's only spelling of a blank line (emptyLine.ts). */
function isEmptyParagraphNode(node: ProseNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

/**
 * Top-level node types that can never themselves prime or need
 * `bulletLastUsed`/the `blankLineJoin` WeakMap: they have no block-level
 * content a nested list could hide in. Confirmed from the actual registered
 * schemas — every OTHER top-level type this schema can produce (`blockquote`,
 * `bullet_list`, `ordered_list`, `footnote_definition`) has block content and
 * is conservatively NOT a leaf; an unrecognized future type name is also not
 * a leaf, by `Set.has` simply returning `false`.
 */
const LEAF_TYPES = new Set<string>([
  'paragraph', // preset-commonmark: content 'inline*'
  'heading', // preset-commonmark: content 'inline*'
  'code_block', // preset-commonmark: content 'text*', marks: '' — fenced, never contains a block
  'hr', // preset-commonmark: no content
  'table', // preset-gfm: content 'table_header_row table_row+' — rows/cells are never top-level and never hold a block-level list
  'html', // preset-commonmark: inline-group node — cannot actually occur as a top-level doc child; listed for completeness
  'image', // preset-commonmark: inline-group node — ditto
  FRONTMATTER_NODE, // milkdown-compat/frontmatter.ts: atom, no content, pinned to position 0
]);

function isLeafNode(node: ProseNode): boolean {
  return LEAF_TYPES.has(node.type.name);
}

/**
 * Splits a document's top-level children into serialization units — see the
 * module header for the two dependency classes this simulates and why a
 * two-pass, retroactive-merge approach is required (a single forward pass
 * that only looks at the immediate predecessor cannot know, at the moment a
 * list primes the WeakMap, whether some later sibling will ever consume it).
 */
export function partitionUnits(doc: ProseNode): ProseNode[][] {
  const children: ProseNode[] = [];
  doc.forEach((child) => children.push(child));
  const n = children.length;
  if (n === 0) return [];

  /** `noCut[i]` — no unit boundary may fall between `children[i]` and `children[i + 1]`. */
  const noCut = new Array<boolean>(Math.max(0, n - 1)).fill(false);

  // Pass 1 — the direct, one-hop case: a list's bullet reaches exactly its
  // very next sibling if that sibling could itself hide a nested list.
  for (let i = 1; i < n; i += 1) {
    const left = children[i - 1] as ProseNode;
    const right = children[i] as ProseNode;
    if (isListNode(left) && !isLeafNode(right)) noCut[i - 1] = true;
  }

  // Pass 2 — the WeakMap span: replay blankLineJoin's own set/restore/clear
  // rules, and retroactively force every gap since the entry was primed open
  // the moment a real RESTORE proves something downstream needed it.
  let liveSince: number | null = null;
  for (let i = 1; i < n; i += 1) {
    const left = children[i - 1] as ProseNode;
    const right = children[i] as ProseNode;
    const leftEmpty = isEmptyParagraphNode(left);
    const rightEmpty = isEmptyParagraphNode(right);

    // RESTORE: an empty left followed by a literal list, with a live entry.
    if (leftEmpty && isListNode(right) && liveSince !== null) {
      for (let k = liveSince; k <= i - 1; k += 1) noCut[k] = true;
    }

    // SET (conservative: any non-leaf, not just a literal list) / CLEAR —
    // mutually exclusive, mirroring blankLineJoin's own early-return shape:
    // an empty `left` can never satisfy `!isLeafNode(left)` (paragraph is
    // always a leaf), so these two branches never both fire for one pair.
    if (!isLeafNode(left) && rightEmpty) {
      if (liveSince === null) liveSince = i - 1;
    } else if (!leftEmpty && !rightEmpty) {
      liveSince = null;
    }
  }

  const units: ProseNode[][] = [[children[0] as ProseNode]];
  for (let i = 1; i < n; i += 1) {
    if (noCut[i - 1]) {
      (units[units.length - 1] as ProseNode[]).push(children[i] as ProseNode);
    } else {
      units.push([children[i] as ProseNode]);
    }
  }
  return units;
}

/** One cached unit: the exact node objects it was built from, and its text. */
interface CacheEntry {
  nodes: ProseNode[];
  text: string;
}

function sameNodes(entry: CacheEntry, nodes: ProseNode[]): boolean {
  if (entry.nodes.length !== nodes.length) return false;
  for (let i = 0; i < nodes.length; i += 1) {
    if (entry.nodes[i] !== nodes[i]) return false;
  }
  return true;
}

/** Strip at most the one trailing `\n` `toMarkdown` adds to a non-empty result. */
function stripAddedTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** The separator `containerFlow`/`blankLineJoin` would put between two units. */
function separatorAfter(unit: ProseNode[]): string {
  const last = unit[unit.length - 1] as ProseNode;
  return isEmptyParagraphNode(last) ? '\n' : '\n\n';
}

export function createBlockSerializer(deps: BlockSerializerDeps): BlockSerializer {
  const cache = new WeakMap<ProseNode, CacheEntry>();

  function cached(unit: ProseNode[]): CacheEntry | undefined {
    const entry = cache.get(unit[0] as ProseNode);
    return entry && sameNodes(entry, unit) ? entry : undefined;
  }

  /** Serializes one unit in an isolated one-off document, filling the cache. */
  function serializeUnit(unit: ProseNode[]): string {
    const hit = cached(unit);
    if (hit) return hit.text;
    const text = stripAddedTrailingNewline(deps.serializeDoc(deps.createDoc(unit)));
    cache.set(unit[0] as ProseNode, { nodes: unit, text });
    return text;
  }

  function joinUnits(units: ProseNode[][], texts: string[]): string {
    let whole = '';
    for (let i = 0; i < texts.length; i += 1) {
      if (i > 0) whole += separatorAfter(units[i - 1] as ProseNode[]);
      whole += texts[i];
    }
    if (whole !== '' && !whole.endsWith('\n') && !whole.endsWith('\r')) whole += '\n';
    return whole;
  }

  function serialize(doc: ProseNode): string {
    const units = partitionUnits(doc);
    const texts = units.map(serializeUnit);
    return joinUnits(units, texts);
  }

  function isPrimed(doc: ProseNode): boolean {
    return partitionUnits(doc).every((unit) => cached(unit) !== undefined);
  }

  function prime(doc: ProseNode, timeRemainingMs: () => number): boolean {
    const units = partitionUnits(doc);
    let didWork = false;
    for (const unit of units) {
      if (cached(unit)) continue;
      if (didWork && timeRemainingMs() <= 0) return false;
      serializeUnit(unit);
      didWork = true;
    }
    return true;
  }

  return { serialize, isPrimed, prime };
}
