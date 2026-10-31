// @vitest-environment jsdom
// Real shipping toolbar/parser/serializer seam; no native input or core imports.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  remarkCtx,
  rootCtx,
} from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { createMarkdownSerializer, type NodeJson } from '@futo-notes/editor/markdown';
import { softBreakView } from './paragraphLines';
import { tableCellLineBreakRemark } from './table/tableLineBreak';
import { wikilink } from './wikilink';
import { createToolbarExec } from './toolbarExec';
import { dismissLinkPrompt } from './linkPrompt';
import { autolinkTransaction } from './autolink';
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
  dismissLinkPrompt();
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

it('Text keeps an already resolved shortcut in definition-shaped heading text', () => {
  const view = editor.ctx.get(editorViewCtx);
  const parse = editor.ctx.get(parserCtx);
  const original = "# [id]: /target 'T'\n\n[one][id]\n\n[id]: /first 'First'";
  const parsed = parse(original);
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content));
  const expectedBefore = [
    { type: 'heading', text: "id: /target 'T'" },
    { type: 'paragraph', text: 'one' },
  ];
  expect(rows(view.state.doc.toJSON() as NodeJson)).toEqual(expectedBefore);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
  createToolbarExec(() => editor).paragraph();
  const after = view.state.doc.toJSON() as NodeJson;
  const expected = [
    { type: 'paragraph', text: "id: /target 'T'" },
    { type: 'paragraph', text: 'one' },
  ];
  const marks = [
    { type: 'link', attrs: { href: '/first', title: 'First' } },
    { type: 'link', attrs: { href: '/first', title: 'First' } },
  ];
  expect(rows(after)).toEqual(expected);
  expect(links(after)).toEqual(marks);
  // A full reference tail preserves the owned shortcut identity while keeping
  // the following colon visible in the actual future paragraph.
  const candidate = parse(
    "[id][id]: /target 'T'\n\n[one][id]\n\n[id]: /first 'First'",
  ).toJSON() as NodeJson;
  expect(rows(candidate)).toEqual(expected);
  expect(links(candidate)).toEqual(marks);
});

it('Text preserves reference label marks and decoded entity spelling intent', () => {
  const view = editor.ctx.get(editorViewCtx);
  const parse = editor.ctx.get(parserCtx);
  for (const label of ['**i&#100;**', 'a&acE;']) {
    const suffix = `: /target 'T'\n\n[one][${label}]\n\n[${label}]: /first 'First'`;
    const parsed = parse(`# [${label}]${suffix}`);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content));
    const before = view.state.doc.toJSON() as NodeJson;
    const expected = rows(before).map((row) => ({ ...row, type: 'paragraph' }));
    const ownedLinks = links(before);
    expect(ownedLinks).toHaveLength(2);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 2)));
    createToolbarExec(() => editor).paragraph();
    const after = view.state.doc.toJSON() as NodeJson;
    expect(rows(after)).toEqual(expected);
    expect(links(after)).toEqual(ownedLinks);
    const candidate = parse(`[${label}][${label}]${suffix}`).toJSON() as NodeJson;
    expect(rows(candidate)).toEqual(expected);
    expect(links(candidate)).toEqual(ownedLinks);
    expect(candidate.content?.[0]?.content).toEqual(after.content?.[0]?.content);
  }
});

it('canonical heading candidates retain a loaded space entity and the clean URL around timing markers', () => {
  const parse = editor.ctx.get(parserCtx);
  const before = parse('# x&#32;\\*b https://x.test/a*').toJSON() as NodeJson;
  const after = parse('# x&#32;*b https://x.test/a*\n').toJSON() as NodeJson;
  expect(rows(before)).toEqual([{ type: 'heading', text: 'x *b https://x.test/a*' }]);
  expect(rows(after)).toEqual([{ type: 'heading', text: 'x b https://x.test/a' }]);
  const target = [{ type: 'link', attrs: { href: 'https://x.test/a', title: null } }];
  expect(links(before)).toEqual(target);
  expect(links(after)).toEqual(target);
  expect(
    after.content?.[0]?.content?.some((part) =>
      part.marks?.some((mark) => mark.type === 'emphasis'),
    ),
  ).toBe(true);
});

it('canonical inner autolink preserves the literal outer angle pair and clean URL on load', () => {
  const parse = editor.ctx.get(parserCtx);
  const candidate = parse('<<https://x.test>>').toJSON() as NodeJson;
  expect(rows(candidate)).toEqual([{ type: 'paragraph', text: '<https://x.test>' }]);
  expect(links(candidate)).toEqual([
    { type: 'link', attrs: { href: 'https://x.test', title: null } },
  ]);
});

it('standard explicit link spelling supports whole and partial Bold inside a literal angle pair', () => {
  const parse = editor.ctx.get(parserCtx);
  for (const [label, styledText, linkMarks] of [
    ['**https://x.test**', 'https://x.test', 1],
    ['**htt**ps://x.test', 'htt', 2],
  ]) {
    const candidate = parse(`\\<[${label}](<https://x.test>)>`).toJSON() as NodeJson;
    expect(rows(candidate)).toEqual([{ type: 'paragraph', text: '<https://x.test>' }]);
    const actualLinks = links(candidate);
    expect(actualLinks).toHaveLength(linkMarks);
    for (const link of actualLinks) {
      expect(link).toEqual({ type: 'link', attrs: { href: 'https://x.test', title: null } });
    }
    const uri = candidate.content?.[0]?.content?.find((part) => part.text === styledText);
    expect(uri?.marks?.map((mark) => mark.type)).toContain('strong');
  }
});

it('the real Link prompt wraps only the selected partial URI in unlinked literal angle text', async () => {
  const view = editor.ctx.get(editorViewCtx);
  const paragraph = view.state.schema.nodes.paragraph.create(
    null,
    view.state.schema.text('<https://x.test>'),
  );
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, paragraph));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 5)));
  expect(links(view.state.doc.toJSON() as NodeJson)).toEqual([]);
  createToolbarExec(() => editor).link();
  let input: HTMLInputElement | null = null;
  await vi.waitFor(() => {
    input = document.body.querySelector('input.futo-selection-toolbar-url');
    expect(input).not.toBeNull();
  });
  input!.value = 'https://new.test';
  input!.dispatchEvent(new Event('input', { bubbles: true }));
  input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() =>
    expect(document.body.querySelector('input.futo-selection-toolbar-url')).toBeNull(),
  );
  const after = view.state.doc.toJSON() as NodeJson;
  expect(rows(after)).toEqual([{ type: 'paragraph', text: '<https://x.test>' }]);
  expect(links(after)).toEqual([
    { type: 'link', attrs: { href: 'https://new.test', title: null } },
  ]);
  expect(
    after.content?.[0]?.content
      ?.filter((part) => part.marks?.some((mark) => mark.type === 'link'))
      .map((part) => part.text),
  ).toEqual(['htt']);
  const parse = editor.ctx.get(parserCtx);
  const candidate = parse('\\<[htt](<https://new.test>)ps://x.test>').toJSON() as NodeJson;
  expect(rows(candidate)).toEqual(rows(after));
  expect(links(candidate)).toEqual(links(after));
});

it('Code over a literal angle URI makes that selected URL opaque without linking it', () => {
  const view = editor.ctx.get(editorViewCtx);
  const paragraph = view.state.schema.nodes.paragraph.create(
    null,
    view.state.schema.text('<https://x.test>'),
  );
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, paragraph));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 16)));
  createToolbarExec(() => editor).code();
  const after = view.state.doc.toJSON() as NodeJson;
  expect(rows(after)).toEqual([{ type: 'paragraph', text: '<https://x.test>' }]);
  expect(links(after)).toEqual([]);
  const uri = after.content?.[0]?.content?.find((part) => part.text === 'https://x.test');
  expect(uri?.marks?.map((mark) => mark.type)).toContain('inlineCode');
  const candidate = editor.ctx.get(parserCtx)('\\<`https://x.test`>').toJSON() as NodeJson;
  expect(rows(candidate)).toEqual(rows(after));
  expect(links(candidate)).toEqual([]);
});

function partialCodeDocument() {
  const view = editor.ctx.get(editorViewCtx);
  const text = '<https://x.test/path>';
  const paragraph = view.state.schema.nodes.paragraph.create(null, view.state.schema.text(text));
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, paragraph));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 16, 21)));
  createToolbarExec(() => editor).code();
  const after = view.state.doc.toJSON() as NodeJson;
  const parse = editor.ctx.get(parserCtx);
  const serializer = createMarkdownSerializer({
    parse: (source) => parse(source).toJSON() as NodeJson,
  });
  return { view, text, after, parse, serializer };
}

it('partial Code command keeps the valid URI prefix literal and word-end owner declines the marked word', () => {
  const { view, text, after, parse, serializer } = partialCodeDocument();
  expect(rows(after)).toEqual([{ type: 'paragraph', text }]);
  expect(links(after)).toEqual([]);
  const code = after.content?.[0]?.content?.find((part) => part.text === '/path');
  expect(code?.marks?.map((mark) => mark.type)).toContain('inlineCode');
  expect(
    autolinkTransaction(
      view.state,
      22,
      (source) => editor.ctx.get(remarkCtx).parse(source),
      (doc) => parse(serializer.serialize(doc.toJSON() as NodeJson)),
    ),
  ).toBeNull();
});

it('characterizes the current serializer losing partial Code after an unlinked URI prefix', () => {
  const { after, parse, serializer } = partialCodeDocument();
  // Observed source-spelling discrepancy, not a portable behavioral golden.
  // The failed intended roundtrip and raw logs remain in the transfer evidence.
  const saved = serializer.serialize(after);
  expect(saved).toBe('\\<https://x.test`/path`>\n');
  const reopened = parse(saved).toJSON() as NodeJson;
  expect(rows(reopened)).toEqual([{ type: 'paragraph', text: '<https://x.test`/path`>' }]);
  expect(
    reopened.content?.[0]?.content?.some((part) =>
      part.marks?.some((mark) => mark.type === 'inlineCode'),
    ),
  ).toBe(false);
});

for (const source of [
  '\\<&#104;ttps://x.test`/path`>',
  '\\<https&#58;//x.test`/path`>',
  '\\<https&colon;//x.test`/path`>',
  '\\<https\\:\\/\\/x\\.test`/path`>',
]) {
  it(`characterizes scalar escaping retaining the prefix autolink: ${source}`, () => {
    const candidate = editor.ctx.get(parserCtx)(source).toJSON() as NodeJson;
    expect(rows(candidate)).toEqual([{ type: 'paragraph', text: '<https://x.test/path>' }]);
    expect(links(candidate)).toEqual([
      { type: 'link', attrs: { href: 'https://x.test', title: null } },
    ]);
    const code = candidate.content?.[0]?.content?.find((part) => part.text === '/path');
    expect(code?.marks?.map((mark) => mark.type)).toContain('inlineCode');
    expect(candidate.content?.[0]?.content?.every((part) => part.type === 'text')).toBe(true);
  });
}
