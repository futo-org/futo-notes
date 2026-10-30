// @vitest-environment jsdom
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
});
afterAll(async () => {
  await editor.destroy();
  root.remove();
});

it('the shipping text-input rule defers an outside emphasis closer in a URL until its word ends', () => {
  const view = editor.ctx.get(editorViewCtx);
  view.updateState(EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }));
  const parse = editor.ctx.get(parserCtx);
  const serializer = createMarkdownSerializer({
    parse: (text) => parse(text).toJSON() as NodeJson,
  });
  editor.ctx.set(serializerCtx, (doc) => serializer.serialize(doc.toJSON() as NodeJson));
  const links = (doc = view.state.doc) => {
    const runs: { text: string; href: string }[] = [];
    doc.descendants((node) => {
      const mark = node.marks.find((mark) => mark.type.name === 'link');
      if (mark) runs.push({ text: node.text ?? '', href: String(mark.attrs.href) });
    });
    return runs;
  };
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
  expect(links()).toEqual([]);
  const beforeSource = serializer.serialize(view.state.doc.toJSON() as NodeJson);
  expect(beforeSource).toBe('x \\*b https://x.test/a\\*\n');
  expect(parse(beforeSource).textContent).toBe('x *b https://x.test/a\\*');
  expect(links(parse(beforeSource))).toEqual([
    { text: 'https://x.test/a\\', href: 'https://x.test/a\\' },
  ]);
  type(' ');
  expect(view.state.doc.textContent).toBe('x b https://x.test/a ');
  expect(emphasis().join('')).toBe('b https://x.test/a');
  expect(links()).toEqual([{ text: 'https://x.test/a', href: 'https://x.test/a' }]);
  const afterSource = serializer.serialize(view.state.doc.toJSON() as NodeJson);
  expect(afterSource).toBe('x *b https://x.test/a*\n');
  expect(parse(afterSource).textContent).toBe('x b https://x.test/a');
  expect(links(parse(afterSource))).toEqual([
    { text: 'https://x.test/a', href: 'https://x.test/a' },
  ]);
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

it('the shipping strong input rule waits for URL word end across both closing stars', () => {
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
  type('x **b https://x.test/a**');
  expect(view.state.doc.textContent).toBe('x **b https://x.test/a**');
  const marked = () => {
    const runs: { text: string; types: string[]; href: unknown }[] = [];
    view.state.doc.descendants((node) => {
      if (node.isText && node.marks.length)
        runs.push({
          text: node.text ?? '',
          types: node.marks.map((mark) => mark.type.name).sort(),
          href: node.marks.find((mark) => mark.type.name === 'link')?.attrs.href,
        });
    });
    return runs;
  };
  expect(marked()).toEqual([]);
  type(' ');
  expect(view.state.doc.textContent).toBe('x b https://x.test/a ');
  expect(marked()).toEqual([
    { text: 'b ', types: ['strong'], href: undefined },
    { text: 'https://x.test/a', types: ['link', 'strong'], href: 'https://x.test/a' },
  ]);
  const parse = editor.ctx.get(parserCtx);
  expect(parse('x \\*\\*b https://x.test/a**').textContent).toBe('x **b https://x.test/a**');
});

it('the shipping composing text transaction retains literal outside delimiters at a bulk word end', () => {
  const view = editor.ctx.get(editorViewCtx);
  view.updateState(EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }));
  const text = 'x *b https://x.test/a* ';
  view.dom.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
  expect(view.composing).toBe(true);
  try {
    // ProseMirror1.42.7 domchange.ts attaches its compositionID to mkTr;
    // the same-text-node branch offers handleTextInput before dispatching mkTr.
    // This exercises that actual composing guard and transaction/plugin seam,
    // not a native keyboard or the final DOM-observer scheduling boundary.
    const { from, to } = view.state.selection;
    const commit = () => view.state.tr.insertText(text, from, to).setMeta('composition', 1);
    const handled = view.someProp('handleTextInput', (handler) =>
      handler(view, from, to, text, commit),
    );
    if (!handled) view.dispatch(commit());
    expect(view.state.doc.textContent).toBe(text);
    const marks: { text: string; types: string[]; href: unknown }[] = [];
    view.state.doc.descendants((node) => {
      if (node.isText && node.marks.length) {
        marks.push({
          text: node.text ?? '',
          types: node.marks.map((mark) => mark.type.name).sort(),
          href: node.marks.find((mark) => mark.type.name === 'link')?.attrs.href,
        });
      }
    });
    expect(marks).toEqual([]);
  } finally {
    view.dom.dispatchEvent(
      new window.CompositionEvent('compositionend', { bubbles: true, data: text }),
    );
  }
});
