// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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

it('the shipping composition transaction links first and the owned compositionend rule then formats', async () => {
  const view = editor.ctx.get(editorViewCtx);
  view.updateState(EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }));
  const text = 'x *b https://x.test/a* ';
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
  view.dom.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
  expect(view.composing).toBe(true);
  try {
    // Pinned ProseMirror domchange.ts supplies this composition-tagged default
    // transaction to the composing guard. This is a transaction/plugin oracle,
    // not native OS input or a claim about DOM-observer scheduling on a phone.
    const { from, to } = view.state.selection;
    const commit = () => view.state.tr.insertText(text, from, to).setMeta('composition', 1);
    const handled = view.someProp('handleTextInput', (handler) =>
      handler(view, from, to, text, commit),
    );
    if (!handled) view.dispatch(commit());
    expect(view.state.doc.textContent).toBe(text);
    expect(marked()).toEqual([
      { text: 'https://x.test/a', types: ['link'], href: 'https://x.test/a' },
    ]);
  } finally {
    view.dom.dispatchEvent(
      new window.CompositionEvent('compositionend', { bubbles: true, data: text }),
    );
    // The real input-rules compositionend callback runs after the commit.
    // Observe its result before editor destruction, rather than outliving ctx.
    await vi.waitFor(() => expect(view.state.doc.textContent).toBe('x b https://x.test/a '));
  }
  expect(marked()).toEqual([
    { text: 'b ', types: ['emphasis'], href: undefined },
    { text: 'https://x.test/a', types: ['emphasis', 'link'], href: 'https://x.test/a' },
  ]);
});

it('the shipping compositionend rule keeps an unfinished URL closer literal and unlinked', async () => {
  const view = editor.ctx.get(editorViewCtx);
  view.updateState(EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }));
  const text = 'x *b https://x.test/a*';
  // A no-op rule has no changed-display condition to await. Drain the owned
  // composition callbacks with the boundary clock before destroying the ctx.
  vi.useFakeTimers();
  try {
    view.dom.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
    expect(view.composing).toBe(true);
    const { from, to } = view.state.selection;
    const commit = () => view.state.tr.insertText(text, from, to).setMeta('composition', 1);
    const handled = view.someProp('handleTextInput', (handler) =>
      handler(view, from, to, text, commit),
    );
    if (!handled) view.dispatch(commit());
    view.dom.dispatchEvent(
      new window.CompositionEvent('compositionend', { bubbles: true, data: text }),
    );
    await vi.runOnlyPendingTimersAsync();
    expect(view.composing).toBe(false);
    expect(view.state.doc.textContent).toBe(text);
    const marked: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.isText && node.marks.length) marked.push(node.text ?? '');
    });
    expect(marked).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

for (const [inner, href, closing] of [
  ['https://x.test/path', 'https://x.test/path', true],
  ['www.x.test/path', 'http://www.x.test/path', true],
  ['https://x.test/path', 'https://x.test/path', false],
  ['www.x.test/path', 'http://www.x.test/path', false],
] as const) {
  it(`the shipping character input owns angle URI word end for ${inner}, closing=${closing}`, () => {
    const view = editor.ctx.get(editorViewCtx);
    view.updateState(
      EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }),
    );
    const parse = editor.ctx.get(parserCtx);
    const serializer = createMarkdownSerializer({
      parse: (text) => parse(text).toJSON() as NodeJson,
    });
    editor.ctx.set(serializerCtx, (doc) => serializer.serialize(doc.toJSON() as NodeJson));
    const linkRuns = (doc = view.state.doc) => {
      const result: { text: string; href: string }[] = [];
      doc.descendants((node) => {
        const mark = node.marks.find((mark) => mark.type.name === 'link');
        if (mark) result.push({ text: node.text ?? '', href: String(mark.attrs.href) });
      });
      return result;
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
    const snapshot = () => {
      const source = serializer.serialize(view.state.doc.toJSON() as NodeJson);
      const reopened = parse(source);
      return {
        text: view.state.doc.textContent,
        links: linkRuns(),
        source,
        reopened: { text: reopened.textContent, links: linkRuns(reopened) },
      };
    };
    // Actual shipping character-input and appendTransaction paths. This is
    // plugin authority, not OS input or native composition evidence.
    type(`<${inner}`);
    const opening = snapshot();
    if (closing) type('>');
    const closed = snapshot();
    type(' ');
    const ended = snapshot();
    const evidence = JSON.stringify({ inner, opening, closed, ended });
    expect(opening.text, evidence).toBe(`<${inner}`);
    expect(opening.links, evidence).toEqual([]);
    expect(closed.text, evidence).toBe(`<${inner}${closing ? '>' : ''}`);
    expect(closed.links, evidence).toEqual([]);
    expect(ended.text, evidence).toBe(`<${inner}${closing ? '>' : ''} `);
    expect(ended.links, evidence).toEqual([{ text: inner, href }]);
  });
}

for (const [delimiter, format] of [
  ['_', 'emphasis'],
  ['~~', 'strike_through'],
] as const) {
  it(`the shipping ${format} URL closer waits for actual character-input word end`, () => {
    const view = editor.ctx.get(editorViewCtx);
    view.updateState(
      EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }),
    );
    const type = (text: string) => {
      for (const ch of text) {
        const { from, to } = view.state.selection;
        const handled = view.someProp('handleTextInput', (handler) =>
          handler(view, from, to, ch, () => view.state.tr.insertText(ch)),
        );
        if (!handled) view.dispatch(view.state.tr.insertText(ch));
      }
    };
    const snapshot = () => {
      const runs: { text: string; types: string[]; href: unknown }[] = [];
      view.state.doc.descendants((node) => {
        if (node.isText && node.marks.length)
          runs.push({
            text: node.text ?? '',
            types: node.marks.map((mark) => mark.type.name).sort(),
            href: node.marks.find((mark) => mark.type.name === 'link')?.attrs.href,
          });
      });
      return { text: view.state.doc.textContent, runs };
    };
    const opening = `x ${delimiter}b https://x.test/a${delimiter}`;
    type(opening);
    const before = snapshot();
    type(' ');
    const ended = snapshot();
    const evidence = JSON.stringify({ delimiter, before, ended });
    expect(before.text, evidence).toBe(opening);
    expect(before.runs, evidence).toEqual([]);
    expect(ended.text, evidence).toBe('x b https://x.test/a ');
    expect(ended.runs, evidence).toEqual([
      { text: 'b ', types: [format], href: undefined },
      { text: 'https://x.test/a', types: [format, 'link'].sort(), href: 'https://x.test/a' },
    ]);
  });
}

for (const [inner, href] of [
  ['www.x.test/[[Old]]/path', 'http://www.x.test/[[Old]]/path'],
  ['https://x.test/a', 'https://x.test/a'],
] as const) {
  for (const closing of [false, true]) {
    it(`the shipping partial ${inner} word ends with literal period and closing=${closing}`, () => {
      const view = editor.ctx.get(editorViewCtx);
      view.updateState(
        EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }),
      );
      const type = (text: string) => {
        for (const ch of text) {
          const { from, to } = view.state.selection;
          const handled = view.someProp('handleTextInput', (handler) =>
            handler(view, from, to, ch, () => view.state.tr.insertText(ch)),
          );
          if (!handled) view.dispatch(view.state.tr.insertText(ch));
        }
      };
      const snapshot = () => {
        const links: { text: string; href: string }[] = [];
        view.state.doc.descendants((node) => {
          const mark = node.marks.find((mark) => mark.type.name === 'link');
          if (mark) links.push({ text: node.text ?? '', href: String(mark.attrs.href) });
        });
        return { text: view.state.doc.textContent, links };
      };
      type(`<${inner}.`);
      const opening = snapshot();
      if (closing) type('>');
      const before = snapshot();
      type(' ');
      const ended = snapshot();
      const evidence = JSON.stringify({ opening, before, ended });
      expect(opening, evidence).toEqual({ text: `<${inner}.`, links: [] });
      expect(before, evidence).toEqual({ text: `<${inner}.${closing ? '>' : ''}`, links: [] });
      expect(ended, evidence).toEqual({
        text: `<${inner}.${closing ? '>' : ''} `,
        links: [{ text: inner, href }],
      });
    });
  }
}

for (const mode of [
  'paste-space',
  'composition-transaction-space',
  'bulk-seed',
  'bulk-continuation',
]) {
  it(`the shipping autolink plugin owns WWW word end through ${mode}`, () => {
    const view = editor.ctx.get(editorViewCtx);
    view.updateState(
      EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }),
    );
    const input = (text: string) => {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, text, () => view.state.tr.insertText(text)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(text));
    };
    const snapshot = () => {
      const links: { text: string; href: string }[] = [];
      view.state.doc.descendants((node) => {
        const mark = node.marks.find((mark) => mark.type.name === 'link');
        if (mark) links.push({ text: node.text ?? '', href: String(mark.attrs.href) });
      });
      return { text: view.state.doc.textContent, links };
    };
    if (mode !== 'bulk-seed') {
      const opening = mode === 'bulk-continuation' ? '<www.x.test/' : '<www.x.test/path';
      for (const ch of opening) input(ch);
      expect(snapshot()).toEqual({ text: opening, links: [] });
    }
    if (mode === 'paste-space') {
      // ProseMirror's actual plain-text paste path; no native clipboard claim.
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type: string) => (type === 'text/plain' ? ' ' : '') },
      });
      expect(view.pasteText(' ', event as ClipboardEvent)).toBe(true);
    } else if (mode === 'composition-transaction-space') {
      // This pins the tagged commit transaction/plugin result, independently of
      // OS delivery or the separately tested owned compositionend input rule.
      view.dispatch(view.state.tr.insertText(' ').setMeta('composition', 1));
    } else {
      // One actual text-input event, distinct from character-by-character input.
      input(mode === 'bulk-seed' ? '<www.x.test/path ' : 'path ');
    }
    expect(snapshot()).toEqual({
      text: '<www.x.test/path ',
      links: [{ text: 'www.x.test/path', href: 'http://www.x.test/path' }],
    });
  });
}

for (const prefix of ['', '<www.x.test/']) {
  it(`the shipping bulk input ends only its last angle word after prefix ${JSON.stringify(prefix)}`, () => {
    const view = editor.ctx.get(editorViewCtx);
    view.updateState(
      EditorState.create({ schema: view.state.schema, plugins: view.state.plugins }),
    );
    const input = (text: string) => {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, text, () => view.state.tr.insertText(text)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(text));
    };
    for (const ch of prefix) input(ch);
    const inserted = 'prefix <www.x.test/path> ';
    input(inserted);
    const links: { text: string; href: string }[] = [];
    view.state.doc.descendants((node) => {
      const mark = node.marks.find((mark) => mark.type.name === 'link');
      if (mark) links.push({ text: node.text ?? '', href: String(mark.attrs.href) });
    });
    const actual = { text: view.state.doc.textContent, links };
    expect(actual, JSON.stringify(actual)).toEqual({
      text: prefix + inserted,
      links: [{ text: 'www.x.test/path', href: 'http://www.x.test/path' }],
    });
  });
}
