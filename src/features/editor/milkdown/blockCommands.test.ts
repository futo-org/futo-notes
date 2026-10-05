import { describe, expect, it } from 'vitest';

import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state';

import {
  blockCommand,
  blockFormatAt,
  changeBlockIndent,
  inIndentableContainer,
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

describe('blockCommand — a code block is literal text', () => {
  it('reads a code block as its own kind, not as plain text', () => {
    expect(blockFormatAt(stateAtFirstText(doc(code('one\ntwo')))).kind).toBe('code');
  });

  // The caret's OWN textblock is the innermost structure, so a fence indented
  // under a list item is code — not the bullet the list item would report.
  it('reads a code block inside a list item as code, not as a bullet', () => {
    const inItem = doc(bullets(s.nodes.list_item.create({ checked: null }, [p('a'), code('cc')])));
    expect(blockFormatAt(stateAtText(inItem, 'cc')).kind).toBe('code');
  });
});

describe('explicit formatting and quote indentation', () => {
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
