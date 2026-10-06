/**
 * The editor's markdown serializer (#266): a pure function from the editor's
 * document (`doc.toJSON()`) to the bytes a save writes, in the house style of
 * docs/spec/editor.md "Markdown house style". No editor-framework imports.
 *
 * ESCAPING IS DECIDED BY PARSING. The serializer is handed the app's own parser
 * (`parse`, Milkdown's `parserCtx` in the app) and escapes a character only
 * when leaving it bare would read back as a different document (`./choose.ts`).
 * A cheap pre-filter skips the parse for a block with nothing in it that could
 * be syntax, which is most prose; a list or a table is checked one item or
 * cell at a time, never parsed whole (parsing a 2,000-item list costs half a
 * second).
 *
 * COST IS PER BLOCK. A top-level block's text depends on the block itself and
 * on a small, cheaply computed context, nothing else:
 *
 *   - `firstLine`  — it starts the file (a `---` there would open front matter);
 *   - `listMarker` — for a list, the marker it alternates to when it touches a
 *                    list of the same kind (`planDocument`);
 *   - `references` — the note's footnote and unused link-reference
 *                    definitions, appended to every parse check so a `[label]`
 *                    or `[^1]` in this block is judged the way the whole note
 *                    reads it. Only a block that needed a parse depends on it
 *                    (`WrittenBlock.checked`).
 *
 * and blocks are joined by a rule that only looks at which blocks are empty
 * paragraphs (`joinDocument`). So a cache can hold one string per top-level
 * block, keyed on the block's identity plus that context, and re-serialize only
 * the blocks that changed — `./cache.ts` is that cache.
 *
 * WHERE IT RUNS. It is the only serializer in the product. The save path keeps
 * a `./cache.ts` over it (src/features/editor/milkdown/serializationLoop.ts);
 * everything else that asks Milkdown for markdown — `getMarkdown()`, the
 * clipboard's text/plain — reaches it through `serializerCtx`, which
 * `../milkdown-compat/ownedSerializer.ts` replaces. Both are handed the
 * editor's own `parserCtx` as `parse`.
 */
import { listKind, listMarkers, writeTopLevel, type ListMarker } from './blocks';
import { chooseSpelling, DEFAULT_CHECK_BUDGET, type CheckBudget, type Reader } from './choose';
import { NODE, isEmptyParagraph, type NodeJson, type ParseMarkdown } from './docJson';
import { canonical, normalizeBlock } from './normalize';
import { render, Sites, type SiteScope } from './pieces';

export type { ListMarker } from './blocks';

export interface BlockContext {
  readonly firstLine: boolean;
  readonly listMarker: ListMarker | null;
  /** `references(...)` of the whole document. */
  readonly references: string;
}

export interface WrittenBlock {
  readonly text: string;
  /** Whether a parse decided it — and so whether it depends on `references`. */
  readonly checked: boolean;
}

/** What the planner and the joiner need to know about a top-level block. */
export interface BlockSummary {
  /** An empty paragraph: written as a blank line between blocks, never as text. */
  readonly empty: boolean;
  readonly listKind: 'bullet' | 'ordered' | null;
  /** The definitions this block contributes to `references`. */
  readonly references: readonly string[];
}

export interface MarkdownSerializerOptions {
  readonly parse: ParseMarkdown;
  /** What one block may spend on parses taking escapes back (`./choose.ts`). */
  readonly checkBudget?: CheckBudget;
}

export interface MarkdownSerializer {
  /** The whole document, as a save writes it. */
  serialize(doc: NodeJson): string;
  /** One top-level block's text, without the separator around it. */
  serializeBlock(block: NodeJson, context: BlockContext): WrittenBlock;
  /** The facts about a top-level block the per-block API needs (`planDocument`, `references`). */
  summarize(block: NodeJson): BlockSummary;
}

/**
 * The definitions a block holds, as the source text a parse check appends: a
 * footnote definition as a stub with its label, an unused link reference
 * definition (kept as an inline `html` atom whose text starts with `[`)
 * verbatim.
 */
function blockReferences(node: NodeJson, out: string[] = []): string[] {
  if (node.type === NODE.footnoteDefinition) out.push(`[^${String(node.attrs?.label ?? '')}]: x`);
  if (node.type === NODE.html && String(node.attrs?.value ?? '').startsWith('[')) {
    out.push(String(node.attrs?.value));
  }
  for (const child of node.content ?? []) blockReferences(child, out);
  return out;
}

export function summarizeBlock(block: NodeJson): BlockSummary {
  const nodes = normalizeBlock(block);
  const [first] = nodes;
  return {
    empty: nodes.length === 1 && first !== undefined && isEmptyParagraph(first),
    listKind: first ? listKind(first) : null,
    references: nodes.flatMap((node) => blockReferences(node)),
  };
}

/** The `references` string for a document whose blocks are summarized as `summaries`. */
export function references(summaries: readonly BlockSummary[]): string {
  return summaries.flatMap((summary) => summary.references).join('\n\n');
}

/**
 * Each top-level block's position: whether it starts the file, and the marker
 * each list is written with — `-`/`.` unless it touches a list of the same
 * kind (only empty paragraphs between), which makes it the other one. Null for
 * an empty paragraph, which is not written. Cheap: no block is serialized.
 */
export function planDocument(
  summaries: readonly BlockSummary[],
): ({ firstLine: boolean; listMarker: ListMarker | null } | null)[] {
  let started = false;
  let emptyBefore = 0;
  const markerFor = listMarkers();
  return summaries.map((summary) => {
    if (summary.empty) {
      emptyBefore += 1;
      return null;
    }
    const listMarker = markerFor(summary.listKind);
    const firstLine = !started && emptyBefore === 0;
    started = true;
    emptyBefore = 0;
    return { firstLine, listMarker };
  });
}

/**
 * The file from its blocks' texts (null for an empty paragraph): `N` empty
 * paragraphs between two blocks are `N + 1` blank lines, `N` before the first
 * block are `N` blank lines at the top, trailing ones are nothing, and a
 * non-empty file ends in one newline.
 */
export function joinDocument(texts: readonly (string | null)[]): string {
  let out = '';
  let started = false;
  let emptyBefore = 0;
  for (const text of texts) {
    if (text === null) {
      emptyBefore += 1;
      continue;
    }
    out += '\n'.repeat(started ? emptyBefore + 2 : emptyBefore) + text;
    started = true;
    emptyBefore = 0;
  }
  return out === '' || out.endsWith('\n') ? out : `${out}\n`;
}

export function createMarkdownSerializer(options: MarkdownSerializerOptions): MarkdownSerializer {
  const { parse } = options;
  const budget = options.checkBudget ?? DEFAULT_CHECK_BUDGET;
  /** The parsed definitions block for each `references` string seen, for the expected reading. */
  const tails = new Map<string, readonly NodeJson[]>();

  function tail(refs: string): readonly NodeJson[] {
    if (refs === '') return [];
    let nodes = tails.get(refs);
    if (!nodes) {
      try {
        nodes = parse(refs).content ?? [];
      } catch {
        nodes = [];
      }
      if (tails.size > 8) tails.clear();
      tails.set(refs, nodes);
    }
    return nodes;
  }

  function reader(refs: string): Reader {
    const suffix = refs === '' ? '' : `\n\n${refs}`;
    return (markdown) => {
      try {
        return canonical(parse(markdown + suffix).content ?? []);
      } catch {
        return null;
      }
    };
  }

  function serializeBlock(block: NodeJson, context: BlockContext): WrittenBlock {
    const nodes = normalizeBlock(block);
    const write = (scope: SiteScope) => {
      const sites = new Sites(scope);
      const lines = writeTopLevel(nodes, context, sites);
      return {
        block: nodes,
        lines,
        siteCount: sites.count,
        layout: sites.layout,
        units: sites.units,
        parts: sites.parts,
        needsCheck: sites.needsCheck,
      };
    };
    const plausible = write('plausible');
    if (!plausible.needsCheck) return { text: render(plausible.lines), checked: false };
    const definitions = tail(context.references);
    const expected = (nodes: readonly NodeJson[]) => canonical([...nodes, ...definitions]);
    const text = chooseSpelling(plausible, write, reader(context.references), expected, budget);
    return { text, checked: true };
  }

  function serialize(doc: NodeJson): string {
    const blocks = doc.content ?? [];
    const summaries = blocks.map(summarizeBlock);
    const refs = references(summaries);
    const plan = planDocument(summaries);
    return joinDocument(
      blocks.map((block, index) => {
        const position = plan[index];
        return position ? serializeBlock(block, { ...position, references: refs }).text : null;
      }),
    );
  }

  return { serialize, serializeBlock, summarize: summarizeBlock };
}
