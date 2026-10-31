// @vitest-environment jsdom
// Canonical case and input transaction controls. The raw paste fixture omits
// app plainTextPaste Markdown interpretation; no native clipboard/IME claim.
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
import { softBreakView } from './paragraphLines';
import { handleParityKeyDown } from './keyboardParity';
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
      .use(autolink)
      .create(),
  );
  editor.ctx.get(editorViewCtx).setProps({
    handleKeyDown: handleParityKeyDown,
    handleScrollToSelection: () => true,
  });
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
  it(`the canonical parser and raw ${action} transaction preserve ${inner}`, () => {
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

for (const [text, inner, href, shiftKey] of [
  ['<www.x.test/path', 'www.x.test/path', 'http://www.x.test/path', false],
  ['<https://x.test/path>', 'https://x.test/path', 'https://x.test/path', true],
] as const) {
  it(`the actual ${shiftKey ? 'Shift+Enter' : 'Enter'} dispatcher ends ${text} with one newline`, () => {
    const view = editor.ctx.get(editorViewCtx);
    view.updateState(
      EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }),
    );
    for (const ch of text) {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, ch, () => view.state.tr.insertText(ch)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(ch));
    }
    const links = () => {
      const found: { text: string; href: string }[] = [];
      view.state.doc.descendants((node) => {
        const mark = node.marks.find((mark) => mark.type.name === 'link');
        if (mark && node.isText)
          found.push({ text: node.text ?? '', href: String(mark.attrs.href) });
      });
      return found;
    };
    expect(links()).toEqual([]);
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    expect(view.someProp('handleKeyDown', (handler) => handler(view, event))).toBe(true);
    expect(view.state.doc.textBetween(0, view.state.doc.content.size, '\n', () => '\n')).toBe(
      `${text}\n`,
    );
    expect(links()).toEqual([{ text: inner, href }]);
    expect(view.state.doc.firstChild?.lastChild?.attrs.isInline).toBe(true);
  });
}

it('an actual committed text transaction ending in LF ends its HTTP word', () => {
  const view = editor.ctx.get(editorViewCtx);
  view.updateState(EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }));
  const text = '<HTTPS://x.test/PaTh>\n';
  view.dispatch(view.state.tr.insertText(text).setMeta('composition', 301));
  const found: { text: string; href: string }[] = [];
  view.state.doc.descendants((node) => {
    const mark = node.marks.find((mark) => mark.type.name === 'link');
    if (mark && node.isText) found.push({ text: node.text ?? '', href: String(mark.attrs.href) });
  });
  expect(view.state.doc.textContent).toBe(text);
  expect(found).toEqual([{ text: 'HTTPS://x.test/PaTh', href: 'HTTPS://x.test/PaTh' }]);
});

// One committed-TEXT branch, covering its remaining separator decisions.
// CRLF/two-space are multiple separators at this seam, not native normalization.
for (const [name, ending, linked] of [
  ['TAB', '\t', true],
  ['NBSP', '\u00a0', true],
  ['CRLF', '\r\n', false],
  ['two spaces', '  ', false],
] as const) {
  it(`committed TEXT with ${name} preserves its actual last-word decision`, () => {
    const view = editor.ctx.get(editorViewCtx);
    view.updateState(
      EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }),
    );
    const inner = 'HTTPS://x.test/PaTh';
    const text = `<${inner}>${ending}`;
    view.dispatch(view.state.tr.insertText(text).setMeta('composition', 301));
    const found: { text: string; href: string }[] = [];
    view.state.doc.descendants((node) => {
      const mark = node.marks.find((mark) => mark.type.name === 'link');
      if (mark && node.isText) found.push({ text: node.text ?? '', href: String(mark.attrs.href) });
    });
    expect(view.state.doc.textContent).toBe(text);
    expect(found).toEqual(linked ? [{ text: inner, href: inner }] : []);
  });
}
