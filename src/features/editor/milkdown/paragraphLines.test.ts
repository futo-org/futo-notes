import { describe, expect, it } from 'vitest';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import {
  EditorState,
  TextSelection,
  type Command,
  type Transaction,
} from '@milkdown/kit/prose/state';

import {
  enterInParagraph,
  isolateSelectedLines,
  joinBackwardAsLine,
  joinForwardAsLine,
} from './paragraphLines';
import { testSchema } from './__fixtures__/schema';

// The keys themselves (and the bytes each one saves) are proven end to end in
// tests/editor-embed-milkdown-interactive.spec.ts. These pin the document
// each command leaves, which no e2e can see without serializing.

const s = testSchema;
const br = (): ProseNode => s.nodes.hardbreak.create({ isInline: true });
const bold = s.marks.strong.create();

/** A top-level paragraph from text, where every `\n` is the inline line break. */
function p(text: string): ProseNode {
  const content: ProseNode[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) content.push(br());
    if (line !== '') content.push(s.text(line));
  });
  return s.nodes.paragraph.create(null, content);
}
const doc = (...blocks: ProseNode[]): ProseNode => s.nodes.doc.create(null, blocks);

/**
 * A state from a marked string: blocks separated by `|`, a `heading:` prefix
 * for an H1, `\n` for the inline line break, `^` for the caret (or anchor) and
 * `$` for the head of a range.
 */
function stateWith(marked: string): EditorState {
  const blocks: ProseNode[] = [];
  const marks: Record<string, number> = {};
  let pos = 0;
  for (const raw of marked.split('|')) {
    const heading = raw.startsWith('heading:');
    const body = heading ? raw.slice('heading:'.length) : raw;
    pos += 1;
    let text = '';
    for (const char of body) {
      if (char === '^' || char === '$') marks[char] = pos;
      else {
        text += char;
        pos += 1;
      }
    }
    pos += 1;
    blocks.push(
      heading ? s.nodes.heading.create({ level: 1 }, text ? s.text(text) : null) : p(text),
    );
  }
  const root = doc(...blocks);
  const anchor = marks['^'];
  if (anchor === undefined) throw new Error('fixture needs a ^ caret');
  return EditorState.create({
    doc: root,
    selection: TextSelection.create(root, anchor, marks.$ ?? anchor),
  });
}

/** The document in the same notation `stateWith` reads. */
function show(state: EditorState): string {
  const { from, to } = state.selection;
  const blocks: string[] = [];
  state.doc.forEach((block, offset) => {
    let text = '';
    let at = offset + 1;
    const caret = (): void => {
      if (at === from) text += '^';
      if (at === to && to !== from) text += '$';
    };
    block.forEach((child) => {
      if (child.isText) {
        for (const char of child.text ?? '') {
          caret();
          text += char;
          at += 1;
        }
      } else {
        caret();
        text += child.type.name === 'hardbreak' ? '\n' : '?';
        at += child.nodeSize;
      }
    });
    caret();
    blocks.push(block.type.name === 'heading' ? `heading:${text}` : text);
  });
  return blocks.join('|');
}

function run(command: Command, state: EditorState): { handled: boolean; state: EditorState } {
  let next = state;
  const handled = command(state, (tr: Transaction) => {
    next = state.apply(tr);
  });
  return { handled, state: next };
}

describe('enterInParagraph', () => {
  it('splits the paragraph at the start of a line rather than opening a blank line inside it', () => {
    const { state } = run(enterInParagraph, stateWith('one\n^two'));
    expect(show(state)).toBe('one|^two');
  });

  it('splits at the very start of a paragraph, leaving an empty paragraph above', () => {
    const { state } = run(enterInParagraph, stateWith('heading:T|^body'));
    expect(show(state)).toBe('heading:T||^body');
  });

  it('replaces a selection inside one paragraph with the newline', () => {
    const { state } = run(enterInParagraph, stateWith('one^ $two'));
    expect(show(state)).toBe('one\n^two');
  });

  it('carries the marks at the caret onto the break, so a bold run stays one run', () => {
    const start = EditorState.create({
      doc: doc(s.nodes.paragraph.create(null, s.text('one', [bold]))),
    });
    const at = start.apply(start.tr.setSelection(TextSelection.atEnd(start.doc)));
    const { state } = run(enterInParagraph, at);
    const paragraph = state.doc.firstChild as ProseNode;
    expect(paragraph.lastChild?.type.name).toBe('hardbreak');
    expect(paragraph.lastChild?.marks.map((mark) => mark.type.name)).toEqual(['strong']);
  });

  it('ends an inline code span at the break: a newline inside one reads back as a space', () => {
    const code = s.marks.inlineCode.create();
    const start = EditorState.create({
      doc: doc(s.nodes.paragraph.create(null, s.text('alpha', [code]))),
    });
    const at = start.apply(start.tr.setSelection(TextSelection.create(start.doc, 4)));
    const { state } = run(enterInParagraph, at);
    const paragraph = state.doc.firstChild as ProseNode;
    expect(paragraph.child(1).type.name).toBe('hardbreak');
    expect(paragraph.child(1).marks).toEqual([]);
  });
});

describe('joinBackwardAsLine', () => {
  it('adds no marks to the break, so exactly one newline goes', () => {
    const bold2 = (text: string): ProseNode => s.nodes.paragraph.create(null, s.text(text, [bold]));
    const start = EditorState.create({ doc: doc(bold2('one'), bold2('two')) });
    const at = start.apply(start.tr.setSelection(TextSelection.create(start.doc, 6)));
    const { state } = run(joinBackwardAsLine, at);
    expect((state.doc.firstChild as ProseNode).child(1).marks).toEqual([]);
  });

  it('leaves an empty paragraph, or one after a non-paragraph, to the default join', () => {
    expect(run(joinBackwardAsLine, stateWith('|^two')).handled).toBe(false);
    expect(run(joinBackwardAsLine, stateWith('one|^')).handled).toBe(false);
    expect(run(joinBackwardAsLine, stateWith('heading:T|^two')).handled).toBe(false);
  });

  it('adds no second line break when the paragraph already starts with one', () => {
    const { state } = run(joinBackwardAsLine, stateWith('one|^\ntwo'));
    expect(show(state)).toBe('one^\ntwo');
  });
});

describe('joinForwardAsLine', () => {
  it('adds no second line break when either side of the boundary already has one', () => {
    expect(show(run(joinForwardAsLine, stateWith('one\n^|two')).state)).toBe('one\n^two');
    expect(show(run(joinForwardAsLine, stateWith('one^|\ntwo')).state)).toBe('one^\ntwo');
  });
});

describe('isolateSelectedLines', () => {
  it('makes the caret line its own paragraph, keeping the lines around it together', () => {
    const { handled, state } = run(isolateSelectedLines, stateWith('a\nb\nm^id\nc\nd'));
    expect(handled).toBe(true);
    expect(show(state)).toBe('a\nb|m^id|c\nd');
  });

  it('keeps a caret at the end of its line on that line', () => {
    const { state } = run(isolateSelectedLines, stateWith('one^\ntwo'));
    expect(show(state)).toBe('one^|two');
  });

  it('keeps a caret at the start of its line on that line', () => {
    const { state } = run(isolateSelectedLines, stateWith('one\n^two'));
    expect(show(state)).toBe('one|^two');
  });

  it('gives every selected line its own paragraph', () => {
    const { state } = run(isolateSelectedLines, stateWith('a\n^b\nc$\nd'));
    expect(show(state)).toBe('a|^b|c$|d');
  });

  it('declines a paragraph with one line, or a block that is not a top-level paragraph', () => {
    expect(run(isolateSelectedLines, stateWith('on^e')).handled).toBe(false);
    expect(run(isolateSelectedLines, stateWith('heading:T^')).handled).toBe(false);
  });
});
