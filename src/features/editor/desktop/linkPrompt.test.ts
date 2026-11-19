/* The engine's `set_link` as the Link prompt submits it (linkPrompt.ts `submit`). */
import { beforeAll, expect, it } from 'vitest';
import { Engine } from './engine';
import { loadEngineBuild } from './__test__/loadEngineBuild';

beforeAll(loadEngineBuild);

const open = (source: string) => Engine.restore({ token: 1, source, revision: 0, paused: false });

it('an empty destination over a selection removes every link it touches, text kept', async () => {
  // Display: "see docs and more now".
  const engine = await open('see [docs](u) and [more](v) now');
  engine.setLink({ start: 0, end: 21 }, '');
  expect(engine.draftText()).toBe('see docs and more now');
  engine.free();
});

it('a destination at a caret outside a link inserts it, the caret after it', async () => {
  const engine = await open('see  now');
  const applied = engine.setLink({ start: 4, end: 4 }, 'https://z.test');
  expect(engine.draftText()).toBe('see https://z.test now');
  expect(applied?.change.selection).toEqual({ start: 18, end: 18 });
  engine.free();
});

it('a new destination on a link changes only the destination', async () => {
  const engine = await open('see [**do**cs](https://x.test "t") now');
  // A caret inside the label: the link it lies in.
  const link = engine.inspectLink({ start: 6, end: 6 })!;
  engine.setLink(link.range, 'https://y.test');
  expect(engine.draftText()).toBe('see [**do**cs](https://y.test "t") now');
  engine.free();
});
