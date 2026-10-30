// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, parserCtx, rootCtx } from '@milkdown/kit/core';
import { EditorState } from '@milkdown/kit/prose/state';
import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { createMarkdownSerializer, type NodeJson } from '@futo-notes/editor/markdown';
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
      .use(gfmWithCompat())
      .create(),
  );
});
afterAll(async () => {
  await editor.destroy();
  root.remove();
});

it('the shipping text-input rule defers an outside emphasis closer in a URL until its word ends', () => {
  const view = editor.ctx.get(editorViewCtx);
  view.updateState(EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }));
  const type = (text: string) => {
    for (const ch of text) {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, ch, () => view.state.tr.insertText(ch)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(ch));
    }
  };
  const emphasis = () => {
    const runs: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'emphasis')) {
        runs.push(node.text ?? '');
      }
    });
    return runs;
  };
  type('x *b https://x.test/a*');
  expect(view.state.doc.textContent).toBe('x *b https://x.test/a*');
  expect(emphasis()).toEqual([]);
  const parse = editor.ctx.get(parserCtx);
  const serializer = createMarkdownSerializer({
    parse: (text) => parse(text).toJSON() as NodeJson,
  });
  const beforeSource = serializer.serialize(view.state.doc.toJSON() as NodeJson);
  expect(beforeSource).toBe('x \\*b https://x.test/a\\*\n');
  expect(parse(beforeSource).textContent).toBe('x *b https://x.test/a\\*');
  type(' ');
  expect(view.state.doc.textContent).toBe('x b https://x.test/a ');
  expect(emphasis()).toEqual(['b https://x.test/a']);
});
