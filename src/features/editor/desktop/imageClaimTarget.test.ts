// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine';
import { createImageClaimTarget } from './imageClaimTarget';
import { mountView } from './__test__/mountView';

beforeEach(() => {
  // A drawn picture waits to come near the pane; jsdom has no IntersectionObserver.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it('writes the saved image at the caret as one Undo step', async () => {
  const { view, engine } = await mountView('ab');
  const discard = vi.fn(async () => {});
  view.selection.selectRange(1, 1);
  const complete = createImageClaimTarget({ view, discard }).begin();
  complete('image-1.png');
  // On a line with text the engine gives the image a line of its own (portable-core/images.md).
  expect(engine.draftText()).toBe('a\n![](image-1.png)\nb');
  view.run((current) => current.undo());
  expect(engine.draftText()).toBe('ab');
  expect(discard).not.toHaveBeenCalled();
  view.destroy();
  engine.free();
});

it('lands where the caret is when the file is saved, after edits made meanwhile', async () => {
  const { view, engine } = await mountView('ab');
  view.selection.selectRange(2, 2);
  const complete = createImageClaimTarget({ view, discard: async () => {} }).begin();
  view.run((current) => current.replace({ start: 2, end: 2 }, ' cd', 'Typing'));
  complete('image-1.png');
  expect(engine.draftText()).toBe('ab cd\n![](image-1.png)\n');
  view.destroy();
  engine.free();
});

it('writes nothing in a note opened since, and deletes the saved file', async () => {
  const { view, engine } = await mountView('ab');
  const discard = vi.fn(async () => {});
  const complete = createImageClaimTarget({ view, discard }).begin();
  // The same note opened again is another session.
  const reopened = await Engine.restore({ token: 2, source: 'ab', revision: 0, paused: false });
  view.open(reopened);
  engine.free();
  complete('image-1.png');
  expect(reopened.draftText()).toBe('ab');
  expect(discard).toHaveBeenCalledWith('image-1.png');
  view.destroy();
  reopened.free();
});

it('deletes the saved file when the caret is in code, where no image goes', async () => {
  const { view, engine } = await mountView('```\ncode\n```');
  const discard = vi.fn(async () => {});
  view.selection.selectRange(2, 2);
  createImageClaimTarget({ view, discard }).begin()('image-1.png');
  expect(engine.draftText()).toBe('```\ncode\n```');
  expect(discard).toHaveBeenCalledWith('image-1.png');
  view.destroy();
  engine.free();
});

it('deletes the saved file when no note is open', async () => {
  const { view, engine } = await mountView('ab');
  const discard = vi.fn(async () => {});
  view.open(null);
  createImageClaimTarget({ view, discard }).begin()('image-1.png');
  expect(discard).toHaveBeenCalledWith('image-1.png');
  view.destroy();
  engine.free();
});

it('waits for an input method to finish composing, then writes the image after its text', async () => {
  const { view, engine } = await mountView('ab');
  const discard = vi.fn(async () => {});
  view.selection.selectRange(2, 2);
  const complete = createImageClaimTarget({ view, discard }).begin();
  view.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
  view.dom.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'k' }));
  complete('image-1.png');
  expect(discard).not.toHaveBeenCalled();
  view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: 'k' }));
  expect(engine.draftText()).toBe('abk\n![](image-1.png)\n');
  expect(discard).not.toHaveBeenCalled();
  view.destroy();
  engine.free();
});
