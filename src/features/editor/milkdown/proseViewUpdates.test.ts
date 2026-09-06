// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMParser, Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, EditorView } from '@milkdown/kit/prose/view';

// Exercise Chromium's selection-write workaround as well as the generic path.
vi.hoisted(() => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Chrome/151.0.0.0' });
});

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    heading: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['h1', 0],
      parseDOM: [{ tag: 'h1' }],
    },
    quote: {
      group: 'block',
      content: 'block+',
      toDOM: () => ['blockquote', 0],
      parseDOM: [{ tag: 'blockquote' }],
    },
    text: {},
  },
});
const paragraph = (text: string) => schema.node('paragraph', null, schema.text(text));
const quote = (...content: ReturnType<typeof paragraph>[]) => schema.node('quote', null, content);
let view: EditorView;
afterEach(() => {
  view?.destroy();
  document.body.textContent = '';
  vi.restoreAllMocks();
});

function mount(plugins: Plugin[] = [], lastBlock?: ReturnType<typeof paragraph>) {
  const blocks = Array.from({ length: 500 }, (_, i) => paragraph(`block ${i}`));
  if (lastBlock) blocks.push(lastBlock);
  view = new EditorView(document.body, {
    state: EditorState.create({ schema, doc: schema.node('doc', null, blocks), plugins }),
  });
  return view;
}
/** How many times a block view's size was read: the cost of locating a block by summing its earlier siblings. */
function spyOnBlockSizeReads() {
  const root = (view as unknown as { docView: { children: object[] } }).docView;
  return vi.spyOn(Object.getPrototypeOf(root.children[0]), 'size', 'get');
}
function expectRenderedDocument() {
  const content = view.dom.cloneNode(true) as HTMLElement;
  content.querySelectorAll('.ProseMirror-widget').forEach((widget) => widget.remove());
  expect(DOMParser.fromSchema(schema).parse(content).eq(view.state.doc)).toBe(true);
}

describe('ProseMirror large-document update patch', () => {
  it('does not read the native selection when an unfocused editable changes', () => {
    mount();
    expect(view.hasFocus()).toBe(false);
    const nativeSelection = vi.spyOn(view, 'domSelectionRange');
    view.dispatch(view.state.tr.insertText('background ', 1));
    expectRenderedDocument();
    expect(nativeSelection).not.toHaveBeenCalled();
  });

  it('still synchronizes the native caret when the editable is focused', () => {
    mount();
    view.focus();
    const nativeSelection = vi.spyOn(view, 'domSelectionRange');
    view.dispatch(view.state.tr.insertText('focused ', 1));
    expect(view.hasFocus()).toBe(true);
    expect(nativeSelection).toHaveBeenCalled();
    expect(document.getSelection()?.focusNode?.textContent).toBe('focused block 0');
    expect(document.getSelection()?.focusOffset).toBe('focused '.length);
    expectRenderedDocument();
  });

  it('retains the selection workaround for read-only views', () => {
    mount();
    view.setProps({ editable: () => false });
    const nativeSelection = vi.spyOn(view, 'domSelectionRange');
    view.dispatch(view.state.tr.insertText('readonly ', 1));
    expect(nativeSelection).toHaveBeenCalled();
    expectRenderedDocument();
  });

  it('reuses unchanged block views without running the general matcher on every block', () => {
    mount();
    // Count the work on the real view, rather than using a machine-speed budget.
    const root = (view as unknown as { docView: { children: object[] } }).docView;
    const proto = Object.getPrototypeOf(root.children[0]);
    const matches = vi.spyOn(proto, 'matchesNode');
    const elements = [...view.dom.children];
    view.dispatch(view.state.tr.insertText('typed ', 1));
    expectRenderedDocument();
    expect([...view.dom.children]).toEqual(elements);
    expect(matches.mock.calls.length).toBeLessThan(10);
  });

  it('locates an edited last block without summing every earlier sibling', () => {
    mount();
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.insertText('warm', end));
    const sizeReads = spyOnBlockSizeReads();
    view.dispatch(view.state.tr.insertText(' typed', end + 4));
    expectRenderedDocument();
    expect(view.state.doc.lastChild!.textContent).toBe('block 499warm typed');
    expect(sizeReads.mock.calls.length).toBeLessThan(50);
  });

  it('positions a nested edit in the last block from the walk too', () => {
    mount([], quote(paragraph('quoted')));
    const end = view.state.doc.content.size - 2;
    const sizeReads = spyOnBlockSizeReads();
    view.dispatch(view.state.tr.insertText('!', end));
    expectRenderedDocument();
    expect(view.dom.lastElementChild!.tagName).toBe('BLOCKQUOTE');
    expect(view.dom.lastElementChild!.textContent).toBe('quoted!');
    expect(sizeReads.mock.calls.length).toBeLessThan(50);
  });

  it('renders edits at both ends, replacements, splits, and deletions', () => {
    mount();
    view.dispatch(
      view.state.tr.insertText('first ', 1).insertText(' last', view.state.doc.content.size + 5),
    );
    expectRenderedDocument();
    view.dispatch(view.state.tr.setNodeMarkup(0, schema.nodes.heading));
    expectRenderedDocument();
    view.dispatch(view.state.tr.split(3));
    expectRenderedDocument();
    view.dispatch(view.state.tr.delete(0, view.state.doc.firstChild!.nodeSize));
    expectRenderedDocument();
  });

  it('keeps decorations current when a text edit changes their position', () => {
    mount([
      new Plugin({
        props: {
          decorations: (state) =>
            DecorationSet.create(state.doc, [
              Decoration.inline(1, 4, { class: 'highlight' }),
              Decoration.widget(5, () => {
                const el = document.createElement('span');
                el.textContent = '!';
                return el;
              }),
            ]),
        },
      }),
    ]);
    view.dispatch(view.state.tr.insertText('x', 1));
    expect(view.dom.querySelector('.highlight')?.textContent).toBe('xbl');
    expect(view.dom.querySelector('.ProseMirror-widget')?.textContent).toBe('!');
    expectRenderedDocument();
  });

  it('reconciles a native DOM edit through the observer', async () => {
    mount();
    view.dom.firstChild!.firstChild!.textContent = 'native input';
    await vi.waitFor(() => expect(view.state.doc.firstChild!.textContent).toBe('native input'));
    expectRenderedDocument();
  });

  it('falls back safely after a text edit followed by a same-count block replacement', () => {
    mount();
    const second = view.state.doc.firstChild!.nodeSize;
    view.dispatch(view.state.tr.insertText('x', 1).setNodeMarkup(second + 1, schema.nodes.heading));
    expectRenderedDocument();
    expect(view.dom.children[1].tagName).toBe('H1');
  });

  it('uses the normal matcher during composition', () => {
    mount();
    const root = (view as unknown as { docView: { children: object[] } }).docView;
    const matches = vi.spyOn(Object.getPrototypeOf(root.children[0]), 'matchesNode');
    const input = (view as unknown as { input: { composing: boolean } }).input;
    input.composing = true;
    try {
      view.dispatch(view.state.tr.insertText('composed ', 1));
      expectRenderedDocument();
      expect(matches.mock.calls.length).toBeGreaterThan(100);
    } finally {
      input.composing = false;
    }
  });
});
