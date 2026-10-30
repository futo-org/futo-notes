// @vitest-environment jsdom
/** Shipping command/transaction oracles for #299, pinned at 6dab1335.
 * These use the real preset schema/plugin state and toolbar entry point.
 * They prove neither native input nor keyboard dispatch. Snapshots record the
 * owned serializer's whole-document spelling, not untouched-source retention.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, parserCtx, rootCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { createMarkdownSerializer } from '@futo-notes/editor/markdown';
import { softBreakView } from './paragraphLines';
import { tableCellLineBreakRemark } from './table/tableLineBreak';
import { wikilink } from './wikilink';
import { createToolbarExec } from './toolbarExec';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';

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
  view.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1 + offset;
  });
  if (found < 0)
    throw new Error(
      `Missing textblock ${JSON.stringify(text)}: ${JSON.stringify(view.state.doc.toJSON())}`,
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

const nested = '- parent\n  - child😀\n    - grandchild\n  - sibling\n- following';
const cases = [
  {
    name: 'nested bullet toggle clears all list ancestors',
    source: nested,
    command: 'bullet-list',
    anchor: 'child😀',
    offset: 7,
  },
  {
    name: 'nested explicit Text clears all list ancestors',
    source: nested,
    command: 'paragraph',
    anchor: 'child😀',
    offset: 7,
  },
  {
    name: 'nested ordered retarget keeps descendants and following siblings',
    source: nested,
    command: 'ordered-list',
    anchor: 'child😀',
    offset: 7,
  },
  {
    name: 'nested ordered toggle clears list ancestors',
    source: '9. parent\n   1. child\n      1. grandchild\n   2. sibling\n10. following',
    command: 'ordered-list',
    anchor: 'child',
  },
  {
    name: 'quote between two lists becomes bullet',
    source: '- before\n\n> middle\n\n- after',
    command: 'bullet-list',
    anchor: 'middle',
  },
  {
    name: 'explicit Text preserves quote ancestry around list',
    source: '> - parent\n>   - child\n>     - grandchild\n>   - sibling\n> - following',
    command: 'paragraph',
    anchor: 'child',
  },
  {
    name: 'mixed selected kinds toggle independently',
    source: '- bullet\n\n> quoted\n\nplain\n\n1. numbered',
    command: 'bullet-list',
    anchor: 'bullet',
    head: 'numbered',
    headOffset: 8,
  },
  {
    name: 'range ending at next item first text position includes that item',
    source: '- first\n- second\n- third',
    command: 'paragraph',
    anchor: 'first',
    head: 'second',
  },
  {
    name: 'range ending at prior item text end excludes next item',
    source: '- first\n- second\n- third',
    command: 'paragraph',
    anchor: 'first',
    head: 'first',
    headOffset: 5,
  },
  {
    name: 'ordered marker width retarget preserves child structure',
    source: '99. parent\n    - child\n100. sibling',
    command: 'bullet-list',
    anchor: 'parent',
  },
  {
    name: 'same physical nested parent survives Text as empty item',
    source: '- - child\n  - sibling\n- following',
    command: 'paragraph',
    anchor: 'child',
  },
  {
    name: 'task paragraph keeps numeric marker literal on opening',
    source: '- [x] 0. text',
    command: 'paragraph',
    anchor: '0. text',
  },
  {
    name: 'checked parent retarget preserves nested fence and continuation',
    source: '- [x] parent\n\n  continuation\n\n  ```js\n  opaque\n  ```\n\n  - child\n- following',
    command: 'ordered-list',
    anchor: 'parent',
  },
  {
    name: 'explicit Text in quote is setBlockType and leaves quote',
    source: '> quoted',
    command: 'paragraph',
    anchor: 'quoted',
  },
  {
    name: 'explicit Quote in quote is a no-op',
    source: '> quoted',
    command: 'quote',
    anchor: 'quoted',
  },
  {
    name: 'nested Heading lifts list ancestry and preserves tail',
    source: nested,
    command: 'heading-2',
    anchor: 'child😀',
  },
  {
    name: 'nested Quote lifts list ancestry and preserves tail',
    source: nested,
    command: 'quote',
    anchor: 'child😀',
  },
  {
    name: 'Text lifts lists surrounding an intervening quote',
    source: '- parent\n  > - child\n  >   - grandchild\n  > - sibling\n- following',
    command: 'paragraph',
    anchor: 'child',
  },
  {
    name: 'Quote within a quoted nested list is a no-op',
    source: '> - parent\n>   - child\n> - following',
    command: 'quote',
    anchor: 'child',
  },
  {
    name: 'Text lifts across two intervening list quote boundaries',
    source:
      '- outer\n  > - middle\n  >   > - child\n  >   >   - grandchild\n  >   > - inner sibling\n  > - middle sibling\n- following',
    command: 'paragraph',
    anchor: 'child',
  },
  {
    name: 'Text selection spanning an ancestor retains the descendant list subtree',
    source: nested,
    command: 'paragraph',
    anchor: 'parent',
    head: 'child😀',
    headOffset: 7,
  },
  {
    name: 'heading in quote becomes list while preserving quote ancestry',
    source: '> ## heading',
    command: 'bullet-list',
    anchor: 'heading',
    offset: 3,
  },
] as const;

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
