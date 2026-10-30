// @vitest-environment jsdom
/*
 * Canary for paragraphLines.ts `lineStartShortcut`, which MIRRORS the block
 * shortcuts the presets' input rules fire at the start of a paragraph — the
 * presets keep their rules inside plugin instances, so the mirror cannot
 * import them. This drives the REAL presets, as the app builds them: each
 * string is typed one character at a time at the start of an empty paragraph,
 * and the presets must turn it into a block on the last character exactly when
 * `lineStartShortcut` says they do. A red case means the presets changed under
 * the pinned `@milkdown/kit`: update the mirror, not this list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { lineStartShortcut } from './paragraphLines';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';

/** Every shortcut the mirror knows, then near-misses that must stay text. */
const TYPED = [
  '- ',
  '* ',
  '+ ',
  '  - ',
  '1. ',
  '12. ',
  '999999999. ',
  '1000000000. ',
  '> ',
  '# ',
  '### ',
  '``` ',
  '```js ',
  '```c++ ',
  '```JavaScript ',
  '```C# ',
  '```ps1 ',
  '###### ',
  '---',
  '___ ',
  '*** ',
  '-',
  '-x',
  'a- ',
  '1) ',
  '1.x',
  '>x',
  '#tag',
  '--',
  '```',
  '```JS ',
  '####### ',
  '__ ',
  '** ',
  '[ ] ',
  '|2x3| ',
];

let editor: Editor;
let view: ProseView;
let root: HTMLElement;

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
  view = editor.ctx.get(editorViewCtx);
});

afterAll(async () => {
  await editor.destroy();
  root.remove();
});

/** Replace the document with one empty paragraph, the caret in it. */
function emptyParagraph(): void {
  const { schema } = view.state;
  const tr = view.state.tr.replaceWith(
    0,
    view.state.doc.content.size,
    schema.nodes.paragraph.create(),
  );
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 1)));
}

/** One keystroke through every `handleTextInput` — the input rules among them. */
function typeChar(text: string): void {
  const { from, to } = view.state.selection;
  const insert = () => view.state.tr.insertText(text, from, to);
  const handled = view.someProp('handleTextInput', (handle) =>
    handle(view, from, to, text, insert),
  );
  if (!handled) view.dispatch(insert());
}

/** Whether the document is still just a paragraph holding `typed`. */
function stillText(typed: string): boolean {
  const { doc } = view.state;
  return (
    doc.childCount === 1 &&
    doc.firstChild?.type.name === 'paragraph' &&
    doc.firstChild.textContent === typed
  );
}

describe('lineStartShortcut agrees with the presets at the start of a paragraph', () => {
  it.each(TYPED)('%j', (typed) => {
    emptyParagraph();
    for (let end = 1; end < typed.length; end += 1) {
      typeChar(typed[end - 1] as string);
      // The list is built so a shortcut fires on its last character only.
      expect(stillText(typed.slice(0, end)), `fired early on ${JSON.stringify(typed)}`).toBe(true);
      expect(lineStartShortcut(typed.slice(0, end))).toBe(false);
    }
    typeChar(typed.at(-1) as string);
    expect(!stillText(typed)).toBe(lineStartShortcut(typed));
  });
});

// Public pinned-shipping reference evidence for #298. The input rule and the
// persisted CommonMark grammar have different digit bounds; this records both.
describe('ordered shortcut digit boundaries in the pinned shipping editor', () => {
  it.each([
    [999999999, 'ordered_list'],
    [1000000000, 'paragraph'],
  ] as const)('types %i as a list and reopens its saved source as %s', (order, reopenedKind) => {
    emptyParagraph();
    for (const char of `${order}. body`) typeChar(char);
    expect(view.state.doc.firstChild?.type.name).toBe('ordered_list');
    expect(view.state.doc.firstChild?.attrs.order).toBe(order);
    const saved = editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc));
    expect(saved).toBe(`${order}. body\n`);
    const reopened = editor.action((ctx) => ctx.get(parserCtx)(saved));
    expect(reopened.firstChild?.type.name).toBe(reopenedKind);
    expect(reopened.firstChild?.textContent).toBe(
      reopenedKind === 'paragraph' ? `${order}. body` : 'body',
    );
  });
});
