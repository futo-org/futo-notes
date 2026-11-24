// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { drawnLineDrift, lineModelDrift } from './lineDrift';
import { LineModel } from './lineModel';
import { showNoteIdChange } from './noteIdDelivery';
import { mountView } from './__test__/mountView';

afterEach(() => vi.unstubAllGlobals());

it('draws links and wikilinks, and a later note-id delivery relabels the wikilinks it changed', async () => {
  const { view, engine } = await mountView(
    'see [**do**cs](https://x.test) and [[Projects/Roadmap]]\nplain [[Other]]',
  );
  const [first, second] = view.lineElements();
  expect(
    [...first.querySelectorAll('.link')].map((span) => [span.className, span.textContent]),
  ).toEqual([
    ['bold link', 'do'],
    ['link', 'cs'],
  ]);
  const wikilink = first.querySelector('.wikilink')!;
  // Its text is the source the engine shows; the label is drawn from the attribute.
  expect(wikilink.textContent).toBe('[[Projects/Roadmap]]');
  expect(wikilink.className).toBe('atom wikilink unresolved');
  expect(wikilink.getAttribute('data-label')).toBe('Projects/Roadmap');

  showNoteIdChange(view, engine.updateNoteIds(['Projects/Roadmap', 'Archive/Roadmap', 'Other']));
  const resolved = first.querySelector('.wikilink')!;
  expect(resolved.className).toBe('atom wikilink');
  // Two notes end in "Roadmap": its shortest unique suffix is the whole id.
  expect(resolved.getAttribute('data-label')).toBe('Projects/Roadmap');
  expect(second.querySelector('.wikilink')!.className).toBe('atom wikilink');
  showNoteIdChange(view, engine.updateNoteIds(['Projects/Roadmap', 'Other']));
  expect(first.querySelector('.wikilink')!.getAttribute('data-label')).toBe('Roadmap');

  const lines = view.displayLines();
  expect(lineModelDrift(lines, LineModel.from(engine.projectAll()).lines)).toBeNull();
  expect(drawnLineDrift(view.lineElements(), lines)).toBeNull();
  view.destroy();
  engine.free();
});
