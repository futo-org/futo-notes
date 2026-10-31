// @vitest-environment jsdom
/** Shipping command/transaction oracles for #299, pinned at 6dab1335.
 * These use the real preset schema/plugin state and toolbar entry point.
 * Key cases invoke the actual direct parity handler and configured preset
 * keymaps; they do not prove native input or OS keyboard dispatch. Snapshots record the
 * owned serializer's whole-document spelling, not untouched-source retention.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  parserCtx,
  rootCtx,
} from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { createMarkdownSerializer } from '@futo-notes/editor/markdown';
import { softBreakView } from './paragraphLines';
import { tableCellLineBreakRemark } from './table/tableLineBreak';
import { wikilink } from './wikilink';
import { createToolbarExec } from './toolbarExec';
import { handleParityKeyDown, keepDeleteForward } from './keyboardParity';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';
import { cases } from './__fixtures__/blockCommandCases';

let editor: Editor;
let view: EditorView;
let root: HTMLElement;
let serialize: ReturnType<typeof createMarkdownSerializer>;

beforeAll(async () => {
  root = document.createElement('div');
  document.body.appendChild(root);
  editor = await withoutLeakedCtxTimers(() =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, '');
        keepDeleteForward(ctx);
        ctx.update(editorViewOptionsCtx, (previous) => ({
          ...previous,
          handleKeyDown: (view, event) => handleParityKeyDown(view, event),
        }));
      })
      .use(commonmarkWithCompat())
      .use(softBreakView)
      .use(gfmWithCompat())
      .use(wikilink)
      .use(tableCellLineBreakRemark)
      .create(),
  );
  view = editor.ctx.get(editorViewCtx);
  // jsdom has no geometry: consume scrolling only, leaving transactions intact.
  view.setProps({ handleScrollToSelection: () => true });
  serialize = createMarkdownSerializer({
    parse: (source) => editor.ctx.get(parserCtx)(source).toJSON(),
  });
});

afterAll(async () => {
  await editor.destroy();
  root.remove();
});

function position(text: string, offset = 0): number {
  let found = -1;
  const observed: string[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) observed.push(node.textContent);
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1 + offset;
  });
  if (found < 0)
    throw new Error(
      `Missing textblock ${JSON.stringify(text)} among ${JSON.stringify(observed)}: ${JSON.stringify(view.state.doc.toJSON())}`,
    );
  return found;
}

function observation() {
  const { doc, selection, storedMarks } = view.state;
  const rows: string[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) rows.push(node.textContent);
  });
  const endpoint = (pos: number) => {
    const resolved = doc.resolve(pos);
    return {
      pm: pos,
      textblockUtf16: resolved.parentOffset,
      ancestry: Array.from({ length: resolved.depth }, (_, i) => resolved.node(i + 1).type.name),
    };
  };
  return {
    source: serialize.serialize(doc.toJSON()),
    // Logical textblock rows, not a DOM/native layout or affinity observation.
    textblockRows: rows.join('\n'),
    documentJson: JSON.stringify(doc.toJSON()),
    selection: { anchor: endpoint(selection.anchor), head: endpoint(selection.head) },
    storedMarks: storedMarks?.map((mark) => mark.toJSON()) ?? null,
  };
}

describe('pinned shipping toolbar container transactions (#299)', () => {
  it.each(cases)('$name', async (example) => {
    const parsed = editor.ctx.get(parserCtx)(example.source);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content));
    const anchor = position(example.anchor, 'offset' in example ? example.offset : 0);
    const head =
      'head' in example
        ? position(example.head, 'headOffset' in example ? example.headOffset : 0)
        : anchor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
    const before = observation();
    createToolbarExec(() => editor)[example.command]();
    await expect({
      input: example.source,
      command: example.command,
      before,
      after: observation(),
    }).toMatchFileSnapshot(
      `./__snapshots__/blockCommands/${example.name.replaceAll(' ', '-')}.snap`,
    );
  });
});

// A declined key records registered-handler behavior only, not browser/OS fallback.
const keyCases = [
  { name: 'Backspace at same line bullet quote', source: '- > b', anchor: 'b' },
  { name: 'Backspace at same line wide ordered quote', source: '1000. > b', anchor: 'b' },
  { name: 'Backspace at bare quote canary', source: '> b', anchor: 'b' },
  { name: 'Backspace between two same line quotes', source: '> - > b', anchor: 'b' },
  { name: 'Backspace at shared line nested list quote', source: '- - > b', anchor: 'b' },
  { name: 'Backspace at nearest inner list after same line quote', source: '- > - b', anchor: 'b' },
  {
    name: 'Backspace keeps quoted inline code opaque inside list parent',
    source: '- > `> b`',
    anchor: '> b',
  },
  {
    name: 'Backspace keeps task body quote punctuation literal',
    source: '- [x] > b',
    anchor: '> b',
  },
  { name: 'Backspace at two nested same line quotes', source: '- > > b', anchor: 'b' },
  { name: 'Backspace at outer quote and two list parents', source: '> - - > b', anchor: 'b' },
  { name: 'Backspace at two lists crossing quotes', source: '- > - > b', anchor: 'b' },
  { name: 'Backspace at three same line list parents', source: '- - - > b', anchor: 'b' },
  {
    name: 'Backspace at explicit multiline quote inside list',
    source: '- > b\n  > c',
    anchor: 'b\nc',
  },
  { name: 'Backspace at lazy multiline quote inside list', source: '- > b\n  c', anchor: 'b\nc' },
  {
    name: 'Backspace at multiline inner quote with retained outer quote',
    source: '> - > b\n>   > c',
    anchor: 'b\nc',
  },
] as const;

describe('pinned shipping configured container keymaps (#299)', () => {
  it.each(keyCases)('$name', async (example) => {
    const parsed = editor.ctx.get(parserCtx)(example.source);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content));
    const at = position(example.anchor);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    const before = observation();
    const event = new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace' });
    const handled = view.someProp('handleKeyDown', (handle) => handle(view, event)) ?? false;
    await expect({
      input: example.source,
      key: 'Backspace',
      before,
      handled,
      after: observation(),
    }).toMatchFileSnapshot(
      `./__snapshots__/blockCommands/${example.name.replaceAll(' ', '-')}.snap`,
    );
  });
});

// Compare compact spelling with explicit physical empty frames. These are
// opening observations, not mutation or untouched-source retention proofs.
const frameSources = [
  '- > b',
  '- \n  > b',
  '- - b',
  '- \n  - b',
  '- - \n    b',
  '- \n  - \n    b',
  '> - - b',
  '> - - \n>     b',
  '- > - b',
  '- > - \n  >   b',
  '- - - b',
  '- - - \n      b',
  '- - + \n      b',
  'parent\n> ```\n> opaque\n> - outside',
  'parent\n> ```\n> opaque\n> ```\n> - outside',
  'parent\n> ```\n> opaque\n\n> - outside',
  'parent\n> ```\n> opaque\n> ```\n\n> - outside',
];
it.each(frameSources)('opens frame candidate %s', async (source) => {
  const parsed = editor.ctx.get(parserCtx)(source);
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content));
  await expect({ input: source, opened: observation() }).toMatchFileSnapshot(
    `./__snapshots__/blockCommands/frame-open-${frameSources.indexOf(source)}.snap`,
  );
});
