/*
 * End-to-end proof for the Shift+Enter table-cell fix, against a REAL
 * `Editor` with the real presets and the real `keyboardParity.ts` key
 * handling — mirroring `tableCommands.roundtrip.test.ts`'s reasoning: what
 * matters is what the real filter plugin and the real remark
 * serializer/parser do, not what a hand-built schema says they should do.
 * `keyboardParity.test.ts` already covers the command in isolation against
 * the fixture schema; this file is the one that can actually reproduce the
 * reported bug (`hardbreakFilterPlugin` only exists in the real preset) and
 * prove the full markdown round trip.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
} from '@milkdown/kit/core';
import { insertHardbreakCommand } from '@milkdown/kit/preset/commonmark';
import { commandsCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { getMarkdown } from '@milkdown/kit/utils';

import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { handleParityKeyDown } from '../keyboardParity';
import { tableGrips } from './tableGrips';
import { withoutLeakedCtxTimers } from '../__fixtures__/noLeakedCtxTimers';

const SOURCE = ['| a | b |', '| --- | --- |', '| r1a | r1b |'].join('\n') + '\n';

async function editorFor(markdown: string) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = await withoutLeakedCtxTimers(() =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          handleKeyDown: (view, event) => handleParityKeyDown(view, event),
        }));
      })
      .use(commonmarkWithCompat())
      .use(gfmWithCompat())
      .use(tableGrips)
      .create(),
  );
  const view = editor.ctx.get(editorViewCtx);
  return {
    view,
    ctx: editor.ctx,
    editor,
    markdown: () => editor.action(getMarkdown()),
    destroy: async () => {
      await editor.destroy();
      root.remove();
    },
  };
}

/** Places the caret at the END of the first text node equal to `text`. */
function putCaretAfter(view: ProseView, text: string): void {
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.isText && node.text === text) at = pos + node.nodeSize;
    return at < 0;
  });
  if (at < 0) throw new Error(`no text node "${text}" in the document`);
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, at));
  view.dispatch(tr);
}

function shiftEnter(view: ProseView): boolean {
  const event = { key: 'Enter', shiftKey: true, isComposing: false } as KeyboardEvent;
  return view.someProp('handleKeyDown', (f) => f(view, event)) ?? false;
}

function typeText(view: ProseView, text: string): void {
  const { from, to } = view.state.selection;
  view.dispatch(view.state.tr.insertText(text, from, to));
}

describe('Shift+Enter inside a table cell — the r1asecond bug', () => {
  it('the preset’s OWN hardbreak command is silently rejected inside a table (the root cause)', async () => {
    const { view, editor, destroy } = await editorFor(SOURCE);
    putCaretAfter(view, 'r1a');
    const before = view.state.doc;
    const commands = editor.ctx.get(commandsCtx);
    // Calling the preset's own command directly (as its Shift-Enter keymap
    // binding would) sets the "hardbreak" transaction meta the filter plugin
    // watches for, so it is filtered out and the document is unchanged.
    commands.call(insertHardbreakCommand.key);
    expect(view.state.doc.eq(before)).toBe(true);
    await destroy();
  });

  it('Shift+Enter now inserts a break instead of fusing the next keystroke into the caret position', async () => {
    const { view, markdown, destroy } = await editorFor(SOURCE);
    putCaretAfter(view, 'r1a');
    expect(shiftEnter(view)).toBe(true);
    typeText(view, 'second');
    const saved = markdown();
    expect(saved).toContain('r1a<br>second');
    expect(saved).not.toContain('r1asecond');
    // The row is still exactly one markdown line — no raw newline escaped
    // into the table.
    const rows = saved.split('\n').filter((line) => line.trim() !== '');
    expect(rows).toHaveLength(3);
    await destroy();
  });

  it('round-trips: save, reopen, save again is byte-identical', async () => {
    const first = await editorFor(SOURCE);
    putCaretAfter(first.view, 'r1a');
    expect(shiftEnter(first.view)).toBe(true);
    typeText(first.view, 'second');
    const savedOnce = first.markdown();
    await first.destroy();

    const second = await editorFor(savedOnce);
    // The saved `<br>` parsed back into a REAL hardbreak, not literal "<br>"
    // text — find the cell's paragraph and check its node kinds.
    const table = second.view.state.doc.firstChild!;
    const cell = table.child(1).child(0); // body row 0, column 0
    const para = cell.child(0);
    const kinds: string[] = [];
    para.forEach((n) => kinds.push(n.isText ? `text:${n.text}` : n.type.name));
    expect(kinds).toEqual(['text:r1a', 'hardbreak', 'text:second']);
    const savedTwice = second.markdown();
    expect(savedTwice).toBe(savedOnce);
    await second.destroy();
  });

  it('outside a table, Shift+Enter keeps the ordinary hardbreak markdown spelling', async () => {
    const { view, markdown, destroy } = await editorFor('hello\n');
    putCaretAfter(view, 'hello');
    expect(shiftEnter(view)).toBe(true);
    typeText(view, 'world');
    const saved = markdown();
    expect(saved).not.toContain('<br>');
    expect(saved).toContain('hello\\\nworld');
    await destroy();
  });
});
