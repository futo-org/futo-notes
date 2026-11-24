/* The engine's side of `[[` completion, as the page drives it (wikilinkCompletion.ts): the run
 * before the caret, an `]]` already after the caret included (the coming `[[` pairing). */
import { beforeAll, expect, it } from 'vitest';
import { Engine } from './engine';
import { loadEngineBuild } from './__test__/loadEngineBuild';

beforeAll(loadEngineBuild);

async function at(source: string, caret: number): Promise<Engine> {
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  engine.updateNoteIds(['Projects/Roadmap', 'Other']);
  engine.placeSelection({ start: caret, end: caret }, 'Backward');
  return engine;
}

it('offers the notes holding the query, and accepting writes the full id, the caret after it', async () => {
  const engine = await at('x [[Ro y', 6);
  const run = engine.wikilinkCompletion()!;
  expect(run.range).toEqual({ start: 2, end: 6 });
  expect(run.candidates.map((one) => one.note_id)).toEqual(['Projects/Roadmap']);
  const applied = engine.acceptWikilinkCompletion(run, 'Projects/Roadmap');
  expect(engine.draftText()).toBe('x [[Projects/Roadmap]] y');
  expect(applied.change.selection).toEqual({ start: 22, end: 22 });
  engine.undo();
  expect(engine.draftText()).toBe('x [[Ro y');
  engine.free();
});

it('takes an `]]` right after the caret into the run it replaces', async () => {
  for (const [source, caret, end] of [
    ['x [[Ro]] y', 6, 8],
    ['x [[]] y', 4, 6],
  ] as const) {
    const engine = await at(source, caret);
    const run = engine.wikilinkCompletion()!;
    expect(run.range).toEqual({ start: 2, end });
    engine.acceptWikilinkCompletion(run, 'Projects/Roadmap');
    expect(engine.draftText()).toBe('x [[Projects/Roadmap]] y');
    engine.free();
  }
});

it('has no run after a finished wikilink', async () => {
  const engine = await at('x [[Other]] y', 13);
  expect(engine.wikilinkCompletion()).toBeNull();
  engine.free();
});
