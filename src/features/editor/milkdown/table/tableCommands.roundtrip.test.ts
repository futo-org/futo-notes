/*
 * Every table mutation must round-trip through markdown correctly, INCLUDING
 * column alignment (QA lane 7 requirement #4). Unlike `tableCommands.test.ts`,
 * which drives a bare `EditorState` against the fixture schema, this drives a
 * REAL `Editor` with the actual `commonmarkWithCompat`/`gfmWithCompat`
 * presets this app ships — the same pipeline `wikilink/__fixtures__/roundTrip.ts`
 * uses for the same reason: what matters is what the real remark
 * serializer/parser do with a mutation this feature makes, not what a
 * hand-built schema says they should do. In particular, `scopedKeepTableAlignPlugin`
 * (mounted by `gfmWithCompat`) — which copies a column's HEADER alignment
 * onto its body cells after any transaction that touches the table — only
 * runs against a real `Editor`'s plugin stack, not a bare `EditorState`.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { TableMap } from '@milkdown/kit/prose/tables';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { getMarkdown } from '@milkdown/kit/utils';

import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import {
  deleteColumnAt,
  deleteRowAt,
  insertColumnAfter,
  insertColumnBefore,
  insertRowAfter,
  insertRowBefore,
} from './tableCommands';

const SOURCE = ['| a | b |', '| --- | :---: |', '| r1a | r1b |'].join('\n') + '\n';

async function editorFor(
  markdown: string,
): Promise<{ view: ProseView; markdown: () => string; destroy: () => Promise<void> }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmarkWithCompat())
    .use(gfmWithCompat())
    .create();
  const view = editor.ctx.get(editorViewCtx);
  return {
    view,
    markdown: () => editor.action(getMarkdown()),
    destroy: async () => {
      await editor.destroy();
      root.remove();
    },
  };
}

/** A position inside the cell at (row, col) of the sole top-level table —
 * row 0 is the header. Mirrors `tableCommands.test.ts`'s `posInCell`, but
 * against the real parsed document rather than a hand-built one. */
function posInCell(view: ProseView, row: number, col: number): number {
  const table = view.state.doc.firstChild!;
  const map = TableMap.get(table);
  return 1 + 1 + map.positionAt(row, col, table) + 1;
}

function run(
  view: ProseView,
  command: (pos: number) => (s: typeof view.state, d: typeof view.dispatch) => boolean,
  pos: number,
): void {
  const applied = command(pos)(view.state, view.dispatch);
  expect(applied).toBe(true);
}

describe('table mutations round-trip through markdown, alignment included', () => {
  it('inserting a row after the header preserves both columns’ alignment', async () => {
    const { view, markdown, destroy } = await editorFor(SOURCE);
    run(view, insertRowAfter, posInCell(view, 0, 0));
    const saved = markdown();
    // Column 0 stays left (no colon), column 1 stays centered (both colons).
    expect(saved).toMatch(/\|\s*-+\s*\|\s*:-+:\s*\|/);
    // The new row landed between the header and the original data row.
    expect(saved.split('\n').filter(Boolean)).toHaveLength(4);
    await destroy();
  });

  it('inserting a column preserves the existing "b" column’s centering, in its new position', async () => {
    const { view, markdown, destroy } = await editorFor(SOURCE);
    run(view, insertColumnAfter, posInCell(view, 0, 0));
    const saved = markdown();
    const delimiterCells = saved
      .split('\n')[1]!
      .split('|')
      .filter((c) => c.trim() !== '');
    expect(delimiterCells).toHaveLength(3);
    // The new middle column is whatever Milkdown's own createAndFill default
    // is (not this feature's concern — table/insertTableCommand does the
    // same); "b" — now the LAST column — must still be centered.
    expect(delimiterCells[2]!.trim()).toMatch(/^:-+:$/);
    expect(saved).toContain('b');
    await destroy();
  });

  it('inserting a column before the centered column keeps the centering on the SAME original column', async () => {
    const { view, markdown, destroy } = await editorFor(SOURCE);
    run(view, insertColumnBefore, posInCell(view, 0, 1));
    const saved = markdown();
    const delimiterCells = saved
      .split('\n')[1]!
      .split('|')
      .filter((c) => c.trim() !== '');
    expect(delimiterCells).toHaveLength(3);
    // "a" (col 0) is untouched; the new column is inserted at col 1; "b" is
    // pushed to col 2 and must still carry its own centering, not the new
    // column's.
    expect(delimiterCells[2]!.trim()).toMatch(/^:-+:$/);
    await destroy();
  });

  it('deleting a row leaves the surviving row and alignment intact', async () => {
    const twoRowSource =
      ['| a | b |', '| --- | :---: |', '| r1a | r1b |', '| r2a | r2b |'].join('\n') + '\n';
    const { view, markdown, destroy } = await editorFor(twoRowSource);
    run(view, deleteRowAt, posInCell(view, 1, 0)); // delete the r1 row
    const saved = markdown();
    expect(saved).toMatch(/\|\s*-+\s*\|\s*:-+:\s*\|/);
    expect(saved).toContain('r2a');
    expect(saved).not.toContain('r1a');
    await destroy();
  });

  it('deleting a column removes exactly that column’s alignment entry', async () => {
    const { view, markdown, destroy } = await editorFor(SOURCE);
    run(view, deleteColumnAt, posInCell(view, 0, 0)); // delete column "a" (left)
    const saved = markdown();
    // Only the centered column remains, and it is still centered.
    const delimiterLine = saved.split('\n')[1]!;
    expect(delimiterLine).toMatch(/^\|\s*:-+:\s*\|$/);
    expect(saved).toContain('b');
    expect(saved).not.toMatch(/\br1a\b/);
    await destroy();
  });

  it('refuses to delete the last row or column — the table survives untouched', async () => {
    const oneRowOneCol = ['| a |', '| --- |', '| r1a |'].join('\n') + '\n';
    const { view, markdown, destroy } = await editorFor(oneRowOneCol);
    // Compare against a round-trip of the SAME pipeline, not the literal
    // input string: remark-stringify pads a table's columns to a uniform
    // width on every save regardless of edits (ADR-0002 normalize-on-save),
    // so even an untouched table's re-serialization can add whitespace.
    // What must hold is "the refused deletes changed nothing AT ALL".
    const before = markdown();
    const rowApplied = deleteRowAt(posInCell(view, 1, 0))(view.state, view.dispatch);
    const colApplied = deleteColumnAt(posInCell(view, 0, 0))(view.state, view.dispatch);
    expect(rowApplied).toBe(false);
    expect(colApplied).toBe(false);
    expect(markdown()).toBe(before);
    await destroy();
  });
});
