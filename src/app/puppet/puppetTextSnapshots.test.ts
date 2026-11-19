import { expect, it } from 'vitest';
import type { Snapshot } from './puppetSnapshots';
import { textSourceDiff } from './puppetTextSnapshots';

function snapshot(source: string, first: number, last: number, screen = 'editor:a'): Snapshot {
  return {
    id: 1,
    t: 0,
    screen,
    elements: [],
    doc: { onScreen: { first, last } },
    selection: null,
    source,
  };
}

it('reads an edit on screen as the hunk of saved markdown on the line it starts', () => {
  const before = snapshot('one\ntwo\nthree', 1, 3);
  const after = snapshot('one\n**two**\nthree', 1, 3);
  expect(textSourceDiff(before, after)).toEqual({ line: 2, removed: 'two', inserted: '**two**' });
});

it('reads an edit wholly off screen as only where it is', () => {
  const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
  const before = snapshot(lines.join('\n'), 1, 10);
  const after = snapshot([...lines.slice(0, 40), 'new', ...lines.slice(40)].join('\n'), 1, 10);
  expect(textSourceDiff(before, after)).toMatchObject({ offScreen: true });
});

it('reads another note as a new screen, not an edit', () => {
  expect(textSourceDiff(snapshot('a', 1, 1), snapshot('b', 1, 1, 'editor:b'))).toBeUndefined();
});

it('reads an empty note as a note: its first letter is an edit', () => {
  expect(textSourceDiff(snapshot('', 1, 1), snapshot('x', 1, 1))).toEqual({
    line: 1,
    removed: '',
    inserted: 'x',
  });
});
