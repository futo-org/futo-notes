// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';

import {
  cycleHeading,
  isListLine,
  parseLine,
  serializeLine,
  toggleBlockquote,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
} from './blockFormatting';

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
});

function setup(
  doc: string,
  selection: { anchor: number; head?: number } = { anchor: 0 },
): EditorView {
  const view = new EditorView({ doc, selection, parent: document.body });
  views.push(view);
  return view;
}

function applyCommand(
  text: string,
  command: (view: EditorView) => void,
  selection: { anchor: number; head?: number } = { anchor: 0 },
): string {
  const view = setup(text, selection);
  command(view);
  return view.state.doc.toString();
}

describe('block formatting transitions', () => {
  it('converts a task to a bullet without retaining checkbox syntax', () => {
    expect(applyCommand('- [ ] foo', toggleBulletList)).toBe('- foo');
  });

  it.each(['- [x] foo', '- [X] foo'])('drops checked task syntax when converting %s', (task) => {
    expect(applyCommand(task, toggleBulletList)).toBe('- foo');
  });

  it('converts a task to an ordered item without retaining checkbox syntax', () => {
    expect(applyCommand('- [ ] foo', toggleOrderedList)).toBe('1. foo');
  });

  it('converts a task to a heading without retaining checkbox syntax', () => {
    expect(applyCommand('- [ ] foo', cycleHeading)).toBe('# foo');
  });

  it('preserves indentation while removing a bullet', () => {
    expect(applyCommand('  - foo', toggleBulletList)).toBe('  foo');
  });

  const starts = {
    none: '  foo',
    bullet: '  - foo',
    ordered: '  7. foo',
    task: '  - [ ] foo',
    heading: '  # foo',
    quote: '  > foo',
  } as const;

  const transitions = {
    bullet: {
      command: toggleBulletList,
      expected: ['  - foo', '  foo', '  - foo', '  - foo', '  - foo', '  - foo'],
    },
    ordered: {
      command: toggleOrderedList,
      expected: ['  1. foo', '  1. foo', '  foo', '  1. foo', '  1. foo', '  1. foo'],
    },
    task: {
      command: toggleTaskList,
      expected: [
        '  - [ ] foo',
        '  - [ ] foo',
        '  - [ ] foo',
        '  foo',
        '  - [ ] foo',
        '  - [ ] foo',
      ],
    },
    heading: {
      command: cycleHeading,
      expected: ['  # foo', '  # foo', '  # foo', '  # foo', '  ## foo', '  # foo'],
    },
    quote: {
      command: toggleBlockquote,
      expected: ['  > foo', '  > foo', '  > foo', '  > foo', '  > foo', '  foo'],
    },
  } as const;

  for (const [commandName, transition] of Object.entries(transitions)) {
    it(`canonicalizes every starting kind when applying ${commandName}`, () => {
      Object.values(starts).forEach((start, index) => {
        expect(applyCommand(start, transition.command)).toBe(transition.expected[index]);
      });
    });
  }

  it.each([
    ['bullet', toggleBulletList, '- foo'],
    ['ordered', toggleOrderedList, '1. foo'],
    ['task', toggleTaskList, '- [ ] foo'],
    ['quote', toggleBlockquote, '> foo'],
  ] as const)('returns a bare line after toggling %s on and off', (_name, command, once) => {
    const view = setup('foo');

    command(view);
    expect(view.state.doc.toString()).toBe(once);
    command(view);
    expect(view.state.doc.toString()).toBe('foo');
  });

  it('cycles a heading through h1, h2, h3, and none', () => {
    const view = setup('foo');

    for (const expected of ['# foo', '## foo', '### foo', 'foo']) {
      cycleHeading(view);
      expect(view.state.doc.toString()).toBe(expected);
    }
  });

  it('applies transitions independently to every selected line', () => {
    const text = '- one\n- [ ] two\nplain';

    expect(applyCommand(text, toggleBulletList, { anchor: 0, head: text.length })).toBe(
      'one\n- two\n- plain',
    );
  });
});

describe('line parsing and serialization', () => {
  it('recognizes a task before the overlapping bullet prefix', () => {
    expect(parseLine('  - [x] done')).toEqual({
      indent: '  ',
      lineKind: { kind: 'task', checked: true },
      content: 'done',
    });
  });

  it.each([
    '',
    'foo',
    '  foo',
    '- foo',
    '\t12. item',
    '- [ ] task',
    '- [x] done',
    '### heading',
    '> quote',
  ])('round-trips %j', (text) => {
    expect(serializeLine(parseLine(text))).toBe(text);
  });

  it.each(['- item', '  3. item', '\t- [X] done'])('identifies indented list line %j', (text) => {
    expect(isListLine(text)).toBe(true);
  });

  it.each(['plain', '  # heading', '> quote'])('rejects non-list line %j', (text) => {
    expect(isListLine(text)).toBe(false);
  });
});
