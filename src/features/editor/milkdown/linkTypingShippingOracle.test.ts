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
  const afterSource = serializer.serialize(view.state.doc.toJSON() as NodeJson);
  expect(afterSource).toBe('x *b https://x.test/a* \n');
  expect(parse(afterSource).textContent).toBe('x b https://x.test/a ');
});

it('a minimal standard source candidate keeps literal URL delimiters stable before conversion', () => {
  const parse = editor.ctx.get(parserCtx);
  const before = parse('x \\*b https://x.test/a*');
  expect(before.textContent).toBe('x *b https://x.test/a*');
  const marks: { text: string; type: string; href: unknown }[] = [];
  before.descendants((node) => {
    for (const mark of node.marks) {
      marks.push({ text: node.text ?? '', type: mark.type.name, href: mark.attrs.href });
    }
  });
  expect(marks).toEqual([{ text: 'https://x.test/a', type: 'link', href: 'https://x.test/a' }]);
});
