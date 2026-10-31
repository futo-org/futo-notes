// @vitest-environment jsdom
// Canonical case and actual input-kind controls; no native clipboard/IME claim.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import { EditorState } from '@milkdown/kit/prose/state';
import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { createMarkdownSerializer, type NodeJson } from '@futo-notes/editor/markdown';
import { autolink } from './autolink';
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
      .use(autolink)
      .create(),
  );
  const parse = editor.ctx.get(parserCtx);
  const serializer = createMarkdownSerializer({
    parse: (text) => parse(text).toJSON() as NodeJson,
  });
  editor.ctx.set(serializerCtx, (doc) => serializer.serialize(doc.toJSON() as NodeJson));
});
afterAll(async () => {
  await editor.destroy();
  root.remove();
});

for (const [inner, href, action] of [
  ['WWW.x.test/path', 'http://WWW.x.test/path', 'characters'],
  ['HTTPS://x.test/path', 'HTTPS://x.test/path', 'paste'],
] as const) {
  it(`the shipping canonical parser and ${action} preserve ${inner}`, () => {
    const view = editor.ctx.get(editorViewCtx);
    view.updateState(
      EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }),
    );
    const links = (doc = view.state.doc) => {
      const result: { text: string; href: string }[] = [];
      doc.descendants((node) => {
        const mark = node.marks.find((mark) => mark.type.name === 'link');
        if (mark) result.push({ text: node.text ?? '', href: String(mark.attrs.href) });
      });
      return result;
    };
    const expected = [{ text: inner, href }];
    const bare = editor.ctx.get(parserCtx)(inner);
    expect(bare.textContent).toBe(inner);
    expect(links(bare)).toEqual(expected);
    if (action === 'characters') {
      for (const ch of `<${inner}>`) {
        const { from, to } = view.state.selection;
        const handled = view.someProp('handleTextInput', (handler) =>
          handler(view, from, to, ch, () => view.state.tr.insertText(ch)),
        );
        if (!handled) view.dispatch(view.state.tr.insertText(ch));
      }
      expect(view.state.doc.textContent).toBe(`<${inner}>`);
      expect(links()).toEqual([]);
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, ' ', () => view.state.tr.insertText(' ')),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(' '));
    } else {
      const text = `<${inner}> `;
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
      });
      expect(view.pasteText(text, event as ClipboardEvent)).toBe(true);
    }
    expect(view.state.doc.textContent).toBe(`<${inner}> `);
    expect(links()).toEqual(expected);
  });
}
