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
