// @vitest-environment jsdom
// Real shipping toolbar/parser/serializer seam; no native input or core imports.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, parserCtx, rootCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { createMarkdownSerializer, type NodeJson } from '@futo-notes/editor/markdown';
import { softBreakView } from './paragraphLines';
import { tableCellLineBreakRemark } from './table/tableLineBreak';
import { wikilink } from './wikilink';
import { createToolbarExec } from './toolbarExec';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';

let editor: Editor;
let root: HTMLDivElement;
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
  editor.ctx.get(editorViewCtx).setProps({ handleScrollToSelection: () => true });
});
afterAll(async () => {
  await editor.destroy();
  root.remove();
});

function rows(node: NodeJson): { type: string; text: string }[] {
  return (node.content ?? []).map((block) => ({
    type: block.type,
    text: (block.content ?? []).map((part) => part.text ?? '').join(''),
  }));
}
function links(node: NodeJson): unknown[] {
  return [
    ...(node.marks ?? []).filter((mark) => mark.type === 'link'),
    ...(node.content ?? []).flatMap(links),
  ];
}

it('Text preserves a heading declaration as literal body instead of creating a reference winner', () => {
  const view = editor.ctx.get(editorViewCtx);
  const parse = editor.ctx.get(parserCtx);
  const original = "# [id]: /target 'T'\n\n[one][id]\n\nbody";
  const parsed = parse(original);
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content));
  expect(rows(view.state.doc.toJSON() as NodeJson)).toEqual([
    { type: 'heading', text: "[id]: /target 'T'" },
    { type: 'paragraph', text: '[one][id]' },
    { type: 'paragraph', text: 'body' },
  ]);
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 1, 1 + "[id]: /target 'T'".length),
    ),
  );
  createToolbarExec(() => editor).paragraph();
  const after = view.state.doc.toJSON() as NodeJson;
  const expected = [
    { type: 'paragraph', text: "[id]: /target 'T'" },
    { type: 'paragraph', text: '[one][id]' },
    { type: 'paragraph', text: 'body' },
  ];
  expect(rows(after)).toEqual(expected);
  expect(links(after)).toEqual([]);
  const serializer = createMarkdownSerializer({
    parse: (source) => parse(source).toJSON() as NodeJson,
  });
  const reopened = parse(serializer.serialize(after)).toJSON() as NodeJson;
  expect(rows(reopened)).toEqual(expected);
  expect(links(reopened)).toEqual([]);
  // This independently verifies the new core's minimal local standard source
  // candidate; whole-document legacy serializer spelling is not copied.
  const candidate = parse("\\[id]: /target 'T'\n\n[one][id]\n\nbody").toJSON() as NodeJson;
  expect(rows(candidate)).toEqual(expected);
  expect(links(candidate)).toEqual([]);
});
