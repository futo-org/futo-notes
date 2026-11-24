// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountView } from './__test__/mountView';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mouse(type: string, target: EventTarget, fields: MouseEventInit = {}): void {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1, ...fields }),
  );
}

it('opens a wikilink and a link on release, moving no caret', async () => {
  const { view, engine, opened } = await mountView('go [[Projects/Roadmap]] and [docs](u) x', [
    'Projects/Roadmap',
  ]);
  view.selection.selectRange(0, 0);
  const wikilink = view.dom.querySelector('.wikilink')!;
  mouse('mousedown', wikilink, { metaKey: true });
  mouse('mouseup', document);
  const link = view.dom.querySelector('.link')!;
  mouse('mousedown', link);
  mouse('mouseup', document);
  mouse('mousedown', wikilink, { button: 1 });
  mouse('mouseup', document, { button: 1 });
  expect(opened.map(({ link, gesture }) => [link, gesture.button, gesture.metaKey])).toEqual([
    [{ kind: 'wikilink', noteId: 'Projects/Roadmap', target: 'Projects/Roadmap' }, 0, true],
    [{ kind: 'link', destination: 'u' }, 0, false],
    [{ kind: 'wikilink', noteId: 'Projects/Roadmap', target: 'Projects/Roadmap' }, 1, false],
  ]);
  expect(view.selection.range()).toEqual({ start: 0, end: 0 });
  view.destroy();
  engine.free();
});

it('opens nothing for a press that moves first, a Shift press or a double click', async () => {
  const { view, engine, opened } = await mountView('go [[Note]] x');
  const wikilink = view.dom.querySelector('.wikilink')!;
  mouse('mousedown', wikilink, { clientX: 10, clientY: 10 });
  mouse('mousemove', document, { clientX: 40, clientY: 10, buttons: 1 });
  mouse('mouseup', document);
  mouse('mousedown', wikilink, { shiftKey: true });
  mouse('mouseup', document);
  mouse('mousedown', wikilink, { detail: 2 });
  mouse('mouseup', document);
  expect(opened).toEqual([]);
  view.destroy();
  engine.free();
});
