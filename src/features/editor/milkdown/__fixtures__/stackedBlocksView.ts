/*
 * A fake ProseMirror view over stacked one-character paragraphs, for the block
 * drag unit tests (blockDragSession.test.ts, handleBlockDrag.test.ts).
 *
 * `view.dom` is a REAL element in the document — the code under test binds
 * listeners to it and to its `ownerDocument` and appends a ghost beside it — and
 * every paragraph is a fixed box, so target resolution is plain arithmetic. The
 * real gesture against a real engine is `tests/editor-embed-milkdown.spec.ts`.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { testSchema } from './schema';

export const BLOCK_HEIGHT = 40;
export const BLOCK_GAP = 20;
const FIRST_TOP = 100;
const LEFT = 24;
const WIDTH = 300;

export function blockTop(index: number): number {
  return FIRST_TOP + index * (BLOCK_HEIGHT + BLOCK_GAP);
}

function rectAt(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: LEFT,
    right: LEFT + WIDTH,
    width: WIDTH,
    height: bottom - top,
    x: LEFT,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

export function makeStackedView(texts: string[]) {
  const nodes = texts.map((text) => testSchema.nodes.paragraph.create(null, testSchema.text(text)));
  const doc = testSchema.nodes.doc.create(null, nodes);
  let state = EditorState.create({ doc });
  const dispatched: Transaction[] = [];

  const dom = document.createElement('div');
  dom.className = 'futo-milkdown ProseMirror';
  dom.getBoundingClientRect = () => rectAt(blockTop(0) - 20, blockTop(texts.length - 1) + 60);
  document.body.appendChild(dom);

  const starts: number[] = [];
  const elements = new Map<number, HTMLElement>();
  let pos = 0;
  nodes.forEach((node, index) => {
    const el = document.createElement('p');
    el.textContent = texts[index];
    el.getBoundingClientRect = () => rectAt(blockTop(index), blockTop(index) + BLOCK_HEIGHT);
    elements.set(pos, el);
    starts.push(pos);
    pos += node.nodeSize;
  });

  const view = {
    get state() {
      return state;
    },
    dom,
    dispatch: (tr: Transaction) => {
      dispatched.push(tr);
      state = state.apply(tr);
    },
    hasFocus: () => false,
    focus: () => {},
    nodeDOM: (at: number) => elements.get(at) ?? null,
    posAtCoords: ({ top: y }: { left: number; top: number }) => {
      for (let index = 0; index < texts.length; index += 1) {
        if (y >= blockTop(index) && y <= blockTop(index) + BLOCK_HEIGHT) {
          return { pos: starts[index] + 1, inside: starts[index] };
        }
      }
      return { pos: state.doc.content.size, inside: -1 };
    },
  } as unknown as ProseView;

  return {
    view,
    dom,
    dispatched,
    /** Document position immediately before the paragraph at `index`. */
    startOf: (index: number) => starts[index],
    element: (index: number) => elements.get(starts[index])!,
    /** The paragraphs' text, top to bottom — what a move changes. */
    order: (): string[] => {
      const out: string[] = [];
      state.doc.forEach((node: ProseNode) => out.push(node.textContent));
      return out;
    },
    /** A pointer y inside paragraph `index`'s lower half. */
    lowerHalf: (index: number) => blockTop(index) + BLOCK_HEIGHT - 4,
    /** A pointer y inside paragraph `index`'s upper half. */
    upperHalf: (index: number) => blockTop(index) + 4,
    destroy: () => dom.remove(),
  };
}
