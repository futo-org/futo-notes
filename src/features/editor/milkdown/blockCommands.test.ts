import { describe, expect, it } from 'vitest';

import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state';

import {
  blockCommand,
  blockFormatAt,
  changeBlockIndent,
  inIndentableContainer,
  setBlockFormat,
  type BlockCommandId,
} from './blockCommands';
import { testSchema } from './__fixtures__/schema';
import { syncListOrderPluginFixture } from './__fixtures__/syncListOrderPlugin';

const s = testSchema;

const p = (text: string): ProseNode => s.nodes.paragraph.create(null, s.text(text));
const h = (level: number, text: string): ProseNode =>
  s.nodes.heading.create({ level }, s.text(text));
const quote = (...blocks: ProseNode[]): ProseNode => s.nodes.blockquote.create(null, blocks);
const item = (text: string, checked: boolean | null = null): ProseNode =>
  s.nodes.list_item.create({ checked }, p(text));
const bullets = (...items: ProseNode[]): ProseNode => s.nodes.bullet_list.create(null, items);
const ordered = (...items: ProseNode[]): ProseNode => s.nodes.ordered_list.create(null, items);
const doc = (...blocks: ProseNode[]): ProseNode => s.nodes.doc.create(null, blocks);
const code = (text: string): ProseNode => s.nodes.code_block.create(null, s.text(text));
/** A one-column GFM table: a header cell, then one body cell. */
const table = (header: string, body: string): ProseNode =>
  s.nodes.table.create(null, [
    s.nodes.table_header_row.create(null, [s.nodes.table_header.create(null, p(header))]),
    s.nodes.table_row.create(null, [s.nodes.table_cell.create(null, p(body))]),
  ]);

/**
 * A state whose caret sits at the first text position of the deepest first
 * child — i.e. "inside the one block this document is about".
 */
function stateAtFirstText(root: ProseNode): EditorState {
  let pos = 0;
  let node = root;
  while (!node.isTextblock && node.childCount > 0) {
    pos += 1;
    node = node.child(0);
  }
  const state = EditorState.create({ doc: root });
  return state.apply(state.tr.setSelection(TextSelection.create(root, pos + 1)));
}

/** A state whose caret sits inside the textblock reading `text`. */
function stateAtText(root: ProseNode, text: string): EditorState {
  let found = -1;
  root.descendants((node, pos) => {
    if (found === -1 && node.isTextblock && node.textContent === text) found = pos + 1;
    return found === -1;
  });
  if (found === -1) throw new Error(`no textblock reading '${text}'`);
  const state = EditorState.create({ doc: root });
  return state.apply(state.tr.setSelection(TextSelection.create(root, found)));
}

/** Run one toolbar block command and return the resulting document. */
function run(root: ProseNode, command: BlockCommandId): ProseNode {
  let state = stateAtFirstText(root);
  const applied = blockCommand(command)(state, (tr: Transaction) => {
    state = state.apply(tr);
  });
  return applied ? state.doc : root;
}

/** `run`, chained — the toolbar tapped several times in a row. */
function runAll(root: ProseNode, ...commands: BlockCommandId[]): ProseNode {
  return commands.reduce((current, command) => run(current, command), root);
}

/** A compact, readable shape of the document tree for assertions. */
function shape(node: ProseNode): unknown {
  if (node.isTextblock) {
    const label = node.type.name === 'heading' ? `h${String(node.attrs.level)}` : node.type.name;
    return `${label}:${node.textContent}`;
  }
  const attrs =
    node.type.name === 'list_item' && node.attrs.checked !== null
      ? `list_item[${node.attrs.checked === true ? 'x' : ' '}]`
      : node.type.name;
  return { [attrs]: node.children.map(shape) };
}

const shapes = (root: ProseNode): unknown[] => root.children.map(shape);

describe('blockFormatAt', () => {
  it('reads the innermost block structure at the caret', () => {
    expect(blockFormatAt(stateAtFirstText(doc(p('plain')))).kind).toBe('none');
    expect(blockFormatAt(stateAtFirstText(doc(h(2, 'title'))))).toEqual({
      kind: 'heading',
      level: 2,
    });
    expect(blockFormatAt(stateAtFirstText(doc(quote(p('q'))))).kind).toBe('quote');
    expect(blockFormatAt(stateAtFirstText(doc(bullets(item('a'))))).kind).toBe('bullet');
    expect(blockFormatAt(stateAtFirstText(doc(ordered(item('a'))))).kind).toBe('ordered');
    expect(blockFormatAt(stateAtFirstText(doc(bullets(item('a', false))))).kind).toBe('task');
  });

  it('reads a list item wrapping a heading as a list, not a heading', () => {
    const nested = doc(bullets(s.nodes.list_item.create(null, h(1, 'x'))));
    expect(blockFormatAt(stateAtFirstText(nested)).kind).toBe('bullet');
  });
});

describe('blockCommand — applying a kind', () => {
  it('turns a paragraph into each block kind', () => {
    expect(shapes(run(doc(p('x')), 'bullet'))).toEqual([
      { bullet_list: [{ list_item: ['paragraph:x'] }] },
    ]);
    expect(shapes(run(doc(p('x')), 'ordered'))).toEqual([
      { ordered_list: [{ list_item: ['paragraph:x'] }] },
    ]);
    expect(shapes(run(doc(p('x')), 'quote'))).toEqual([{ blockquote: ['paragraph:x'] }]);
    expect(shapes(run(doc(p('x')), 'heading-1'))).toEqual(['h1:x']);
    expect(shapes(run(doc(p('x')), 'task'))).toEqual([
      { bullet_list: [{ 'list_item[ ]': ['paragraph:x'] }] },
    ]);
  });

  it('gives the new list item its own wrapper, not the bare paragraph', () => {
    const list = run(doc(p('x')), 'bullet').child(0);
    expect(list.child(0).type.name).toBe('list_item');
  });
});

describe('blockCommand — removing the kind that is already there', () => {
  it('bullet on a bullet leaves a plain paragraph', () => {
    expect(shapes(run(doc(bullets(item('x'))), 'bullet'))).toEqual(['paragraph:x']);
  });

  it('ordered on an ordered leaves a plain paragraph', () => {
    expect(shapes(run(doc(ordered(item('x'))), 'ordered'))).toEqual(['paragraph:x']);
  });

  it('task on a task leaves a plain paragraph, not a bullet', () => {
    expect(shapes(run(doc(bullets(item('x', false))), 'task'))).toEqual(['paragraph:x']);
  });

  // The bug this replaced: wrapInBlockquoteCommand nested, giving `> > x`.
  it('quote on a quote leaves its depth alone', () => {
    expect(shapes(run(doc(quote(p('x'))), 'quote'))).toEqual([{ blockquote: ['paragraph:x'] }]);
  });

  it('Text returns a heading to a paragraph', () => {
    expect(shapes(runAll(doc(p('x')), 'heading-3', 'paragraph'))).toEqual(['paragraph:x']);
  });
});

describe('blockCommand — converting between kinds', () => {
  it('converts bullet to ordered and back', () => {
    const asOrdered = run(doc(bullets(item('x'))), 'ordered');
    expect(shapes(asOrdered)).toEqual([{ ordered_list: [{ list_item: ['paragraph:x'] }] }]);
    expect(shapes(run(asOrdered, 'bullet'))).toEqual([
      { bullet_list: [{ list_item: ['paragraph:x'] }] },
    ]);
  });

  it('converts a bullet to a task and back without leaving the list', () => {
    const asTask = run(doc(bullets(item('x'))), 'task');
    expect(shapes(asTask)).toEqual([{ bullet_list: [{ 'list_item[ ]': ['paragraph:x'] }] }]);
    expect(shapes(run(asTask, 'bullet'))).toEqual([
      { bullet_list: [{ list_item: ['paragraph:x'] }] },
    ]);
  });

  it('converts an ordered item into a task, which is a bullet list item', () => {
    expect(shapes(run(doc(ordered(item('x'))), 'task'))).toEqual([
      { bullet_list: [{ 'list_item[ ]': ['paragraph:x'] }] },
    ]);
  });

  // editor.md: "Converting a checked task drops its checkbox state along with
  // the task prefix."
  it('drops the checkbox when a checked task converts to another kind', () => {
    const checked = doc(bullets(item('x', true)));
    expect(shapes(run(checked, 'ordered'))).toEqual([
      { ordered_list: [{ list_item: ['paragraph:x'] }] },
    ]);
  });

  it('converts a quote into a bullet and a bullet into a quote', () => {
    expect(shapes(run(doc(quote(p('x'))), 'bullet'))).toEqual([
      { bullet_list: [{ list_item: ['paragraph:x'] }] },
    ]);
    expect(shapes(run(doc(bullets(item('x'))), 'quote'))).toEqual([
      { blockquote: ['paragraph:x'] },
    ]);
  });

  it('converts a heading into a bullet and a bullet into a heading', () => {
    expect(shapes(run(doc(h(2, 'x')), 'bullet'))).toEqual([
      { bullet_list: [{ list_item: ['paragraph:x'] }] },
    ]);
    expect(shapes(run(doc(bullets(item('x'))), 'heading-1'))).toEqual(['h1:x']);
  });
});

describe('blockCommand — retargetList survives syncListOrderPlugin (QA #002)', () => {
  /**
   * `stateAtText`, but with the preset's own self-healing plugin installed —
   * exactly the gap the reference diagnosis called out: every other test in
   * this file runs against a plugin-free `EditorState`, which never fires
   * `appendTransaction` and so can't see a plugin revert the toggle.
   */
  function stateWithPlugin(root: ProseNode, text: string): EditorState {
    let found = -1;
    root.descendants((node, pos) => {
      if (found === -1 && node.isTextblock && node.textContent === text) found = pos + 1;
      return found === -1;
    });
    if (found === -1) throw new Error(`no textblock reading '${text}'`);
    const state = EditorState.create({ doc: root, plugins: [syncListOrderPluginFixture()] });
    return state.apply(state.tr.setSelection(TextSelection.create(root, found)));
  }

  /** Run one command and let the plugin's `appendTransaction` fold in, same as the real editor. */
  function applyWithPlugin(state: EditorState, command: BlockCommandId): EditorState {
    let after = state;
    blockCommand(command)(state, (tr) => {
      after = state.apply(tr);
    });
    return after;
  }

  // Reported repro: 3 bullet lines, caret on the LAST line. Numbered List
  // converts all three (this direction "worked" only because the plugin's
  // self-heal papered over the old bug). Bullet List, pressed again with the
  // caret still on the last line, used to do nothing at all.
  it('toggles a 3-item list from ordered back to bullet, not just the touched item', () => {
    const bulletList = doc(bullets(item('a'), item('b'), item('c')));
    let state = stateWithPlugin(bulletList, 'c');

    state = applyWithPlugin(state, 'ordered');
    expect(shapes(state.doc)).toEqual([
      {
        ordered_list: [
          { list_item: ['paragraph:a'] },
          { list_item: ['paragraph:b'] },
          { list_item: ['paragraph:c'] },
        ],
      },
    ]);

    state = applyWithPlugin(state, 'bullet');
    expect(shapes(state.doc)).toEqual([
      {
        bullet_list: [
          { list_item: ['paragraph:a'] },
          { list_item: ['paragraph:b'] },
          { list_item: ['paragraph:c'] },
        ],
      },
    ]);
  });

  it('toggles a 3-item list from bullet to task and back to bullet, every item', () => {
    const bulletList = doc(bullets(item('a'), item('b'), item('c')));
    let state = stateWithPlugin(bulletList, 'a');

    state = applyWithPlugin(state, 'task');
    expect(shapes(state.doc)).toEqual([
      {
        bullet_list: [
          { 'list_item[ ]': ['paragraph:a'] },
          { 'list_item[ ]': ['paragraph:b'] },
          { 'list_item[ ]': ['paragraph:c'] },
        ],
      },
    ]);

    state = applyWithPlugin(state, 'bullet');
    expect(shapes(state.doc)).toEqual([
      {
        bullet_list: [
          { list_item: ['paragraph:a'] },
          { list_item: ['paragraph:b'] },
          { list_item: ['paragraph:c'] },
        ],
      },
    ]);
  });
});

describe('blockCommand — nesting', () => {
  /** `- a` / `- b` with `- c` nested under b. */
  const nested = doc(
    bullets(item('a'), s.nodes.list_item.create(null, [p('b'), bullets(item('c'))])),
  );

  function applyAt(root: ProseNode, text: string, command: BlockCommandId): EditorState {
    const state = stateAtText(root, text);
    let after = state;
    blockCommand(command)(state, (tr: Transaction) => {
      after = state.apply(tr);
    });
    return after;
  }

  /** The node type names wrapping the textblock reading `text`. */
  function ancestorsOf(root: ProseNode, text: string): string[] {
    const state = stateAtText(root, text);
    const at = state.selection.$from;
    const names: string[] = [];
    for (let d = at.depth; d > 0; d -= 1) names.push(at.node(d).type.name);
    return names;
  }

  it('converting a list converts the whole enclosing list, nesting intact', () => {
    // Markdown has no mixed bullet/ordered list, so the enclosing list is the
    // smallest thing that can change kind. The nested list is a different list
    // and stays a bullet list.
    const after = applyAt(nested, 'a', 'ordered').doc;
    expect(after.child(0).type.name).toBe('ordered_list');
    expect(ancestorsOf(after, 'c')).toEqual([
      'paragraph',
      'list_item',
      'bullet_list',
      'list_item',
      'ordered_list',
    ]);
  });

  it('converting a nested item converts only its own list', () => {
    const after = applyAt(nested, 'c', 'ordered').doc;
    expect(after.child(0).type.name).toBe('bullet_list');
    expect(ancestorsOf(after, 'c')).toContain('ordered_list');
  });

  it('making a nested item a task leaves the item where it is', () => {
    const after = applyAt(nested, 'c', 'task').doc;
    expect(ancestorsOf(after, 'c')).toEqual([
      'paragraph',
      'list_item',
      'bullet_list',
      'list_item',
      'bullet_list',
    ]);
    expect(after.textContent).toBe('abc');
  });

  it('removing the bullet from a nested item lifts it clear of every list', () => {
    const after = applyAt(nested, 'c', 'bullet').doc;
    expect(ancestorsOf(after, 'c')).not.toContain('list_item');
    expect(after.textContent).toBe('abc');
  });
});

describe('blockCommand — one transaction', () => {
  it('applies a two-step conversion as a single transaction', () => {
    const state = stateAtFirstText(doc(quote(p('x'))));
    const dispatched: Transaction[] = [];
    blockCommand('bullet')(state, (tr) => dispatched.push(tr));
    expect(dispatched).toHaveLength(1);
  });

  it('is a clean no-op, not a throw, when the schema has no list', () => {
    const bare = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'inline*' },
        text: { group: 'inline' },
      },
    });
    const state = EditorState.create({
      doc: bare.nodes.doc.create(null, bare.nodes.paragraph.create(null, bare.text('x'))),
    });
    const dispatched: Transaction[] = [];
    expect(blockCommand('bullet')(state, (tr) => dispatched.push(tr))).toBe(false);
    expect(dispatched).toHaveLength(0);
  });
});

describe('blockCommand — a selection spanning several blocks', () => {
  /** Select from inside the first textblock to the end of the last. */
  function selectEverything(root: ProseNode): EditorState {
    const blocks: { start: number; end: number }[] = [];
    root.descendants((node, pos) => {
      if (node.isTextblock) blocks.push({ start: pos + 1, end: pos + 1 + node.content.size });
      return true;
    });
    const state = EditorState.create({ doc: root });
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    return state.apply(state.tr.setSelection(TextSelection.create(root, first.start, last.end)));
  }

  function runAcross(root: ProseNode, command: BlockCommandId): unknown[] {
    let state = selectEverything(root);
    const applied = blockCommand(command)(state, (tr: Transaction) => {
      state = state.apply(tr);
    });
    return (applied ? state.doc : root).children.map(shape);
  }

  it('wraps several selected paragraphs into ONE list, not one list each', () => {
    expect(runAcross(doc(p('a'), p('b')), 'bullet')).toEqual([
      { bullet_list: [{ list_item: ['paragraph:a'] }, { list_item: ['paragraph:b'] }] },
    ]);
  });

  it('wraps several selected paragraphs into one blockquote', () => {
    expect(runAcross(doc(p('a'), p('b')), 'quote')).toEqual([
      { blockquote: ['paragraph:a', 'paragraph:b'] },
    ]);
  });

  // Plain `lift` cannot lift two list_items into the doc, so this used to be a
  // silent no-op: selecting a whole list and tapping Bullet did nothing.
  it('removes the bullet from every selected item', () => {
    expect(runAcross(doc(bullets(item('a'), item('b'))), 'bullet')).toEqual([
      'paragraph:a',
      'paragraph:b',
    ]);
  });

  it('converts every selected item to ordered', () => {
    expect(runAcross(doc(bullets(item('a'), item('b'))), 'ordered')).toEqual([
      { ordered_list: [{ list_item: ['paragraph:a'] }, { list_item: ['paragraph:b'] }] },
    ]);
  });

  it('sets the same heading level across a mixed selection', () => {
    expect(runAcross(doc(h(1, 'a'), p('b')), 'heading-2')).toEqual(['h2:a', 'h2:b']);
  });

  it('toggles each kind separately across a mixed selection', () => {
    expect(runAcross(doc(bullets(item('a')), p('b')), 'bullet')).toEqual([
      'paragraph:a',
      { bullet_list: [{ list_item: ['paragraph:b'] }] },
    ]);
  });

  it('chooses a level independently of the existing headings', () => {
    expect(runAcross(doc(h(2, 'a'), h(2, 'b')), 'heading-3')).toEqual(['h3:a', 'h3:b']);
  });
});

describe('blockCommand — a code block is literal text', () => {
  const ALL: BlockCommandId[] = ['heading-1', 'quote', 'bullet', 'ordered', 'task'];

  /** The command run at `text`, as `[applied, resulting shapes]`. */
  function runAt(root: ProseNode, text: string, command: BlockCommandId): [boolean, unknown[]] {
    let state = stateAtText(root, text);
    const applied = blockCommand(command)(state, (tr: Transaction) => {
      state = state.apply(tr);
    });
    return [applied, state.doc.children.map(shape)];
  }

  it('reads a code block as its own kind, not as plain text', () => {
    expect(blockFormatAt(stateAtFirstText(doc(code('one\ntwo')))).kind).toBe('code');
  });

  // The caret's OWN textblock is the innermost structure, so a fence indented
  // under a list item is code — not the bullet the list item would report.
  it('reads a code block inside a list item as code, not as a bullet', () => {
    const inItem = doc(bullets(s.nodes.list_item.create({ checked: null }, [p('a'), code('cc')])));
    expect(blockFormatAt(stateAtText(inItem, 'cc')).kind).toBe('code');
  });

  // The reported bug: Quote on the blank line of an open fence wrapped the
  // WHOLE fence in a blockquote (`> \`\`\``), and Heading turned the fence into
  // a heading, collapsing its newlines into spaces.
  it.each(ALL)('%s leaves a top-level code block untouched', (command) => {
    const root = doc(code('code line one\n'));
    const [applied, shapes] = runAt(root, 'code line one\n', command);
    expect(applied).toBe(false);
    expect(shapes).toEqual(['code_block:code line one\n']);
  });

  it.each(ALL)('%s leaves a code block inside a list item untouched', (command) => {
    const root = doc(bullets(s.nodes.list_item.create({ checked: null }, [p('a'), code('cc')])));
    const [applied, shapes] = runAt(root, 'cc', command);
    expect(applied).toBe(false);
    expect(shapes).toEqual([{ bullet_list: [{ list_item: ['paragraph:a', 'code_block:cc'] }] }]);
  });

  // A GFM table cell holds one line of inline content: no markdown prefix can
  // apply to it either, and the schema is what says so.
  it.each(ALL)('%s leaves a table cell untouched', (command) => {
    const root = doc(table('H', 'cell'));
    const [applied, shapes] = runAt(root, 'cell', command);
    expect(applied).toBe(false);
    expect(shapes).toEqual([
      {
        table: [
          { table_header_row: [{ table_header: ['paragraph:H'] }] },
          { table_row: [{ table_cell: ['paragraph:cell'] }] },
        ],
      },
    ]);
  });
});

describe('blockCommand — a selection spanning a code block', () => {
  /** Select from the first textblock to the last, then run `command`. */
  function runAcrossAll(root: ProseNode, command: BlockCommandId): unknown[] {
    const blocks: { start: number; end: number }[] = [];
    root.descendants((node, pos) => {
      if (node.isTextblock) blocks.push({ start: pos + 1, end: pos + 1 + node.content.size });
      return true;
    });
    let state = EditorState.create({ doc: root });
    state = state.apply(
      state.tr.setSelection(
        TextSelection.create(root, blocks[0].start, blocks[blocks.length - 1].end),
      ),
    );
    const applied = blockCommand(command)(state, (tr: Transaction) => {
      state = state.apply(tr);
    });
    return (applied ? state.doc : root).children.map(shape);
  }

  it('quotes the prose either side of a fence and leaves the fence alone', () => {
    expect(runAcrossAll(doc(p('a'), code('cc'), p('b')), 'quote')).toEqual([
      { blockquote: ['paragraph:a'] },
      'code_block:cc',
      { blockquote: ['paragraph:b'] },
    ]);
  });

  it('does not swallow a fence into a list built from the prose around it', () => {
    expect(runAcrossAll(doc(p('a'), code('cc')), 'bullet')).toEqual([
      { bullet_list: [{ list_item: ['paragraph:a'] }] },
      'code_block:cc',
    ]);
  });
});

describe('explicit formatting and quote indentation', () => {
  it('chooses each heading level without cycling on a second tap', () => {
    for (const level of [1, 2, 3]) {
      let state = stateAtFirstText(doc(h(3, 'x')));
      const command = setBlockFormat({ kind: 'heading', level });
      for (let i = 0; i < 2; i++)
        command(state, (tr) => {
          state = state.apply(tr);
        });
      expect(shapes(state.doc)).toEqual([`h${level}:x`]);
    }
  });

  it('changes the heading inside a quote without removing its indentation', () => {
    let state = stateAtFirstText(doc(quote(quote(p('x')))));
    setBlockFormat({ kind: 'heading', level: 2 })(state, (tr) => {
      state = state.apply(tr);
    });
    expect(shapes(state.doc)).toEqual([{ blockquote: [{ blockquote: ['h2:x'] }] }]);
  });

  it('outdents a quote exactly one level per transaction', () => {
    let state = stateAtFirstText(doc(quote(quote(p('x')))));
    const dispatched: Transaction[] = [];
    const outdent = () =>
      changeBlockIndent(-1)(state, (tr) => {
        dispatched.push(tr);
        state = state.apply(tr);
      });
    outdent();
    expect(shapes(state.doc)).toEqual([{ blockquote: ['paragraph:x'] }]);
    outdent();
    expect(shapes(state.doc)).toEqual(['paragraph:x']);
    expect(dispatched).toHaveLength(2);
  });

  it('indents a quote once and keeps its siblings outside the new level', () => {
    let state = stateAtText(doc(quote(p('a'), p('b'), p('c'))), 'b');
    changeBlockIndent(1)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(shapes(state.doc)).toEqual([
      { blockquote: ['paragraph:a', { blockquote: ['paragraph:b'] }, 'paragraph:c'] },
    ]);
  });

  it('does not indent ordinary prose or code', () => {
    for (const root of [doc(p('x')), doc(quote(code('x')))]) {
      const state = stateAtFirstText(root);
      expect(changeBlockIndent(1)(state)).toBe(false);
      expect(changeBlockIndent(-1)(state)).toBe(false);
    }
  });
});

describe('inIndentableContainer', () => {
  it('is true for a bare caret in a list item or a blockquote', () => {
    expect(inIndentableContainer(stateAtFirstText(doc(bullets(item('a')))).selection.$from)).toBe(
      true,
    );
    expect(inIndentableContainer(stateAtFirstText(doc(ordered(item('a')))).selection.$from)).toBe(
      true,
    );
    expect(inIndentableContainer(stateAtFirstText(doc(quote(p('a')))).selection.$from)).toBe(true);
  });

  it('is true for a heading or a code fence nested inside a quote — unlike blockFormatAt, which reports the innermost kind', () => {
    const heading = stateAtFirstText(doc(quote(h(2, 'x'))));
    expect(blockFormatAt(heading).kind).toBe('heading');
    expect(inIndentableContainer(heading.selection.$from)).toBe(true);
  });

  it('is false for ordinary prose', () => {
    expect(inIndentableContainer(stateAtFirstText(doc(p('x'))).selection.$from)).toBe(false);
  });

  it('is false inside a code fence, even one nested in a quote — changeBlockIndent refuses it too', () => {
    expect(inIndentableContainer(stateAtFirstText(doc(code('x'))).selection.$from)).toBe(false);
    expect(inIndentableContainer(stateAtFirstText(doc(quote(code('x')))).selection.$from)).toBe(
      false,
    );
  });
});
