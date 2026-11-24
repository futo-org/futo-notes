// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { drawnLineDrift, lineModelDrift } from './lineDrift';
import { LineModel } from './lineModel';
import { mountView, type MountedView } from './__test__/mountView';

afterEach(() => vi.unstubAllGlobals());

/** Pictures load as they near the pane (pictureLoading.ts): in jsdom, none does. */
async function mountWithPictures(source: string): Promise<MountedView> {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return mountView(source);
}

/** Each line's gap classes, `picture-line` marked `P`, by its text. */
function gapsShown({ view }: MountedView): string[] {
  return view.lineElements().map((element) => {
    const marks = ['picture-line', 'gap-above', 'gap-below']
      .filter((name) => element.classList.contains(name))
      .map((name) => (name === 'picture-line' ? 'P' : name));
    return [element.textContent, ...marks].join(' ');
  });
}

function expectNoDrift({ view, engine }: MountedView): void {
  const lines = view.displayLines();
  expect(lineModelDrift(lines, LineModel.from(engine.projectAll()).lines)).toBeNull();
  expect(drawnLineDrift(view.lineElements(), lines)).toBeNull();
}

it('gives a picture line a gap from a picture, code block or table beside it, not from text', async () => {
  const mounted = await mountWithPictures(
    'text\n![](a.png)\n![](b.png) ![](c.png)\n```\ncode\n```\n![](d.png)\n| a |\n| - |\n\n![](e.png) words',
  );
  try {
    expect(gapsShown(mounted)).toEqual([
      'text',
      '![](a.png) P',
      '![](b.png) ![](c.png) P gap-above gap-below',
      'code',
      '![](d.png) P gap-above gap-below',
      '| a |',
      '| - |',
      '',
      '![](e.png) words',
    ]);
  } finally {
    mounted.view.destroy();
    mounted.engine.free();
  }
});

it('gives two picture lines their gap once the line between them goes, and takes it after Undo', async () => {
  const mounted = await mountWithPictures('![](a.png)\nmid\n![](b.png)');
  const { view, engine } = mounted;
  try {
    const mid = view.displayLines()[1];
    view.run((current) =>
      current.replace({ start: mid.byteStart - 1, end: mid.byteStart + 3 }, '', 'Typing'),
    );
    expect(gapsShown(mounted)).toEqual(['![](a.png) P', '![](b.png) P gap-above']);
    expectNoDrift(mounted);
    view.run((current) => current.undo());
    expect(gapsShown(mounted)).toEqual(['![](a.png) P', 'mid', '![](b.png) P']);
    expectNoDrift(mounted);
  } finally {
    view.destroy();
    engine.free();
  }
});

it('keeps a gap under the front matter panel, on its last line', async () => {
  const mounted = await mountWithPictures('---\ntitle: x\ntags: y\n---\nbody');
  try {
    const panel = mounted.view
      .lineElements()
      .filter((element) => element.classList.contains('metadata'));
    expect(panel.length).toBeGreaterThan(0);
    expect(panel.map((element) => element.classList.contains('gap-below'))).toEqual(
      panel.map((_, index) => index === panel.length - 1),
    );
    expectNoDrift(mounted);
  } finally {
    mounted.view.destroy();
    mounted.engine.free();
  }
});
