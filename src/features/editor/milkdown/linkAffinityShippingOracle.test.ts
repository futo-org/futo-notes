// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Editor, defaultValueCtx, parserCtx, rootCtx } from '@milkdown/kit/core';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
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

// This is the shipping schema's public transaction boundary. It pins mark
// inclusivity and retained hrefs, not keyboard handlers, native input or pixels.
function insert(source: string, at: number) {
  const parse = editor.ctx.get(parserCtx);
  const doc = parse(source);
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, at) });
  const tr = state.tr.insertText('x');
  const links: { text: string; href: string }[] = [];
  tr.doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((mark) => mark.type.name === 'link');
    if (mark) links.push({ text: node.text ?? '', href: String(mark.attrs.href) });
  });
  const serialize = createMarkdownSerializer({ parse: (text) => parse(text).toJSON() as NodeJson });
  return {
    source: serialize.serialize(tr.doc.toJSON() as NodeJson),
    display: tr.doc.textContent,
    links,
    selection: tr.selection.from,
  };
}

for (const [at, source, linked, selection] of [
  [1, 'x[ab](https://x.test)\n', 'ab', 2],
  [2, '[axb](https://x.test)\n', 'axb', 3],
  [3, '[ab](https://x.test)x\n', 'ab', 4],
] as const) {
  it(`shipping links have noninclusive boundaries and retain destination at PM position ${at}`, () => {
    expect(insert('[ab](https://x.test)', at)).toEqual({
      source,
      display: at === 1 ? 'xab' : at === 2 ? 'axb' : 'abx',
      links: [{ text: linked, href: 'https://x.test' }],
      selection,
    });
  });
}

it('outer bold survives at a link boundary without extending the destination', () => {
  expect(insert('__[ab](https://x.test)__', 3)).toEqual({
    source: '**[ab](https://x.test)x**\n',
    display: 'abx',
    links: [{ text: 'ab', href: 'https://x.test' }],
    selection: 4,
  });
});

it('adjacent equal link marks form one contiguous run', () => {
  expect(insert('[ab](https://x.test)[cd](https://x.test)', 3)).toEqual({
    source: '[abxcd](https://x.test)\n',
    display: 'abxcd',
    links: [{ text: 'abxcd', href: 'https://x.test' }],
    selection: 4,
  });
});
