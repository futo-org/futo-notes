/**
 * The `[[wikilink]]` ProseMirror node: an inline ATOM holding the raw target,
 * rendered as an anchor showing the shortest unique suffix.
 *
 * Atomic because display and source deliberately differ — `[[Projects/Roadmap]]`
 * reads as "Roadmap" (docs/spec/editor.md), and a caret inside a shortened
 * rendering has no honest position in the source. The target survives in the
 * node's attrs and serializes back verbatim through `syntax.ts`, so the file on
 * disk keeps whatever the user (or another tool) wrote.
 *
 * The rendered TEXT depends on the note universe, which the host replaces at
 * any time through `setNotes`. Re-rendering therefore must not touch the
 * document: a transaction would make `setNotes` look like a user edit and
 * normalize-save the note. `refreshWikilinkViews` mutates the node views' own
 * DOM instead, which ProseMirror owns but does not read back.
 */
import { $nodeSchema, $view } from '@milkdown/kit/utils';
import type {
  Mark as ProseMark,
  Node as ProseNode,
  NodeType,
  ResolvedPos,
  Schema as ProseSchema,
} from '@milkdown/kit/prose/model';
import type { MarkdownNode, ParserState, SerializerState } from '@milkdown/kit/transformer';
import type { EditorView as ProseView, NodeView } from '@milkdown/kit/prose/view';

import { getWikilinkIndex } from '$features/notes/notes.svelte';
import { wikilinkDisplay } from './display';
import { WIKILINK_MDAST_TYPE } from './syntax';

export const WIKILINK_NODE = 'wikilink';

/** The attribute the pointer handlers read the raw target back out of. */
export const WIKILINK_TARGET_ATTR = 'data-wikilink';

export const wikilinkSchema = $nodeSchema(WIKILINK_NODE, () => ({
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: false,
  marks: '',
  attrs: { target: { default: '', validate: 'string' } },
  parseDOM: [
    {
      tag: `a[${WIKILINK_TARGET_ATTR}]`,
      getAttrs: (dom: HTMLElement | string) => ({
        target: typeof dom === 'string' ? '' : (dom.getAttribute(WIKILINK_TARGET_ATTR) ?? ''),
      }),
    },
  ],
  // Only reached when no node view is mounted (copy/drag serialization). The
  // node view below is what the reader actually sees.
  toDOM: (node: ProseNode) => [
    'a',
    { [WIKILINK_TARGET_ATTR]: node.attrs.target as string },
    node.attrs.target as string,
  ],
  // Copy-as-plain-text and `doc.textBetween` get the source syntax back.
  leafText: (node: ProseNode) => `[[${node.attrs.target as string}]]`,
  parseMarkdown: {
    match: ({ type }: MarkdownNode) => type === WIKILINK_MDAST_TYPE,
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      state.addNode(type, { target: (node.target as string | undefined) ?? '' });
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === WIKILINK_NODE,
    runner: (state: SerializerState, node: ProseNode) => {
      state.addNode(WIKILINK_MDAST_TYPE, undefined, undefined, {
        target: node.attrs.target as string,
      });
    },
  },
}));

/** Builds the node, so the schema walk lives with the schema. */
export function createWikilink(schema: ProseSchema, target: string): ProseNode {
  return schema.nodes[WIKILINK_NODE].create({ target });
}

/**
 * True when text typed at `$pos` would land in code — a fenced/indented code
 * BLOCK or an inline code SPAN.
 *
 * The two are different shapes in ProseMirror: a code block is a node with
 * `spec.code`, inline code is a mark on a text node. Checking only the first is
 * a real hole — `[[` typed inside backticks would open the completion popup and
 * write a chip into a code span, against docs/spec/editor.md's "Wikilinks and
 * tags inside inline code or fenced blocks are NOT decorated and NOT
 * extracted". Parsing gets this right for free (micromark runs no text
 * constructs inside code); only the INPUT paths need telling.
 *
 * `storedMarks` decides it when set, exactly as it decides what the next
 * keystroke is marked with — a caret at the closing edge of a code span reports
 * no marks (code marks are non-inclusive, so typing there leaves the span) and
 * really is outside it.
 */
export function isInCode($pos: ResolvedPos, storedMarks?: readonly ProseMark[] | null): boolean {
  if ($pos.parent.type.spec.code) return true;
  const marks = storedMarks ?? $pos.marks();
  return marks.some((mark) => mark.type.spec.code || mark.type.name === 'inlineCode');
}

/**
 * The live node views of one editor. Keyed by view so two editors on one page
 * (desktop after the swap) refresh independently, and so a destroyed editor's
 * views are not held alive.
 */
const viewsByEditor = new WeakMap<ProseView, Set<WikilinkNodeView>>();

class WikilinkNodeView implements NodeView {
  readonly dom: HTMLAnchorElement;
  private target: string;
  private readonly editorView: ProseView;

  constructor(node: ProseNode, editorView: ProseView) {
    this.target = node.attrs.target as string;
    this.editorView = editorView;
    this.dom = document.createElement('a');
    this.render();
    let peers = viewsByEditor.get(editorView);
    if (!peers) {
      peers = new Set();
      viewsByEditor.set(editorView, peers);
    }
    peers.add(this);
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== WIKILINK_NODE) return false;
    this.target = node.attrs.target as string;
    this.render();
    return true;
  }

  /** ProseMirror must not try to read the anchor's children as document text. */
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    viewsByEditor.get(this.editorView)?.delete(this);
  }

  render(): void {
    const { text, className } = wikilinkDisplay(this.target, getWikilinkIndex());
    this.dom.className = className;
    this.dom.setAttribute(WIKILINK_TARGET_ATTR, this.target);
    this.dom.textContent = text;
  }
}

export const wikilinkView = $view(wikilinkSchema.node, () => (node, editorView) => {
  return new WikilinkNodeView(node, editorView as ProseView);
});

/**
 * Re-render every wikilink in `view` against the CURRENT note universe. Called
 * from the editor's `refreshDecorations()`, which the host reaches through
 * `setNotes` — the moment a link can stop being broken, or start being one.
 */
export function refreshWikilinkViews(view: ProseView | null): void {
  if (!view) return;
  for (const nodeView of viewsByEditor.get(view) ?? []) nodeView.render();
}
