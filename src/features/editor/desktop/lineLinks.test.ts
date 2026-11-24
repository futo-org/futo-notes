import { beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { classedRuns, outsideLinkEdge } from './lineLinks';
import { LineModel } from './lineModel';
import { loadEngineBuild } from './__test__/loadEngineBuild';

beforeAll(loadEngineBuild);

async function linesOf(source: string, noteIds: string[] = []): Promise<LineModel> {
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  engine.updateNoteIds(noteIds);
  const model = LineModel.from(engine.projectAll());
  engine.free();
  return model;
}

describe('a line read from the engine', () => {
  it('holds its links, web addresses and wikilinks, a wikilink labelled by the engine', async () => {
    // Display: "a label b [[Projects/Roadmap]] c https://y.test d [[Missing]]".
    const model = await linesOf(
      'a [label](https://x.test) b [[Projects/Roadmap]] c https://y.test d [[Missing]]',
      ['Projects/Roadmap', 'Other/Roadmap2'],
    );
    const [line] = model.lines;
    expect(line.links).toEqual([
      { start: 2, end: 7, destination: 'https://x.test' },
      { start: 33, end: 47, destination: 'https://y.test' },
    ]);
    expect(line.atoms).toEqual([
      {
        kind: 'Wikilink',
        start: 10,
        end: 30,
        image: null,
        target: 'Projects/Roadmap',
        label: 'Roadmap',
        noteId: 'Projects/Roadmap',
      },
      {
        kind: 'Wikilink',
        start: 50,
        end: 61,
        image: null,
        target: 'Missing',
        label: 'Missing',
        noteId: null,
      },
    ]);
  });

  it('keeps a list marker before a wikilink on its item, in order', async () => {
    const model = await linesOf('- [[Note]] x');
    expect(model.lines[0].atoms.map((atom) => atom.kind)).toEqual(['ListMarker', 'Wikilink']);
  });

  it('classes a link over its formats, cut at every edge of either', async () => {
    // Display: "x bold y": "bo" bold inside the link "bold".
    const model = await linesOf('x [**bo**ld](u) y');
    expect(classedRuns(model.lines[0])).toEqual([
      { start: 2, end: 4, className: 'bold link' },
      { start: 4, end: 6, className: 'link' },
    ]);
  });
});

describe('outsideLinkEdge', () => {
  it('names the side outside a link at its edges, none inside or between two links', async () => {
    // Display: "alabelb" and "abcd" (two links touching).
    const [one, two] = (await linesOf('a[label](u)b\n[ab](u)[cd](v)')).lines;
    expect(outsideLinkEdge(one, 1)).toBe('Backward');
    expect(outsideLinkEdge(one, 6)).toBe('Forward');
    expect(outsideLinkEdge(one, 3)).toBeNull();
    expect(outsideLinkEdge(two, 0)).toBe('Backward');
    expect(outsideLinkEdge(two, 2)).toBeNull();
    expect(outsideLinkEdge(two, 4)).toBe('Forward');
  });

  it('is the side the engine types outside the link on', async () => {
    for (const [at, affinity, typed] of [
      [1, 'Backward', 'aX[label](u)b'],
      [6, 'Forward', 'a[label](u)Xb'],
    ] as const) {
      const engine = await Engine.restore({
        token: 1,
        source: 'a[label](u)b',
        revision: 0,
        paused: false,
      });
      engine.placeSelection({ start: at, end: at }, affinity);
      engine.replace({ start: at, end: at }, 'X', 'Typing');
      expect(engine.draftText()).toBe(typed);
      engine.free();
    }
  });
});
