// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Engine } from './engine';
import { LineModel } from './lineModel';
import { fitSelectionToWikilinks } from './wikilinkUnit';
import { loadEngineBuild } from './__test__/loadEngineBuild';
import { mountView } from './__test__/mountView';

beforeAll(loadEngineBuild);
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function key(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function input(target: EventTarget, inputType: string): void {
  target.dispatchEvent(
    new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType }),
  );
}

// Display: "a [[Projects/Roadmap]] b": the wikilink 2..22.
async function model(): Promise<LineModel> {
  const engine = await Engine.restore({
    token: 1,
    source: 'a [[Projects/Roadmap]] b',
    revision: 0,
    paused: false,
  });
  const lines = LineModel.from(engine.projectAll());
  engine.free();
  return lines;
}

describe('a wikilink as one unit', () => {
  it('fits a moved end out of it on the side it was going, else the nearer side', async () => {
    const lines = await model();
    const caret = (at: number) => ({ anchor: at, focus: at });
    // A word motion back from after it stops inside (the engine's words): it goes on to the start.
    expect(fitSelectionToWikilinks(lines, caret(13), { start: 22, end: 22 })).toEqual(caret(2));
    expect(fitSelectionToWikilinks(lines, caret(12), { start: 0, end: 0 })).toEqual(caret(22));
    expect(fitSelectionToWikilinks(lines, caret(5), { start: 5, end: 5 })).toEqual(caret(2));
    expect(fitSelectionToWikilinks(lines, caret(20), { start: 20, end: 20 })).toEqual(caret(22));
    const outside = { anchor: 0, focus: 24 };
    expect(fitSelectionToWikilinks(lines, outside, { start: 0, end: 0 })).toBe(outside);
  });

  it('comes back whole with one Undo after its whole range is deleted', async () => {
    const engine = await Engine.restore({
      token: 1,
      source: 'a [[Projects/Roadmap]] b',
      revision: 0,
      paused: false,
    });
    engine.replace({ start: 2, end: 22 }, '', 'Isolated');
    expect(engine.draftText()).toBe('a  b');
    engine.undo();
    expect(engine.draftText()).toBe('a [[Projects/Roadmap]] b');
    engine.free();
  });

  it('takes Left, Right and Shift+Left over it, through the editor’s keys', async () => {
    const { view, engine } = await mountView('a [[Projects/Roadmap]] b');
    view.selection.selectRange(22, 22);
    key(view.dom, { key: 'ArrowLeft' });
    expect(view.selection.range()).toEqual({ start: 2, end: 2 });
    key(view.dom, { key: 'ArrowRight' });
    expect(view.selection.range()).toEqual({ start: 22, end: 22 });
    key(view.dom, { key: 'ArrowLeft', shiftKey: true });
    expect(view.selection.range()).toEqual({ start: 2, end: 22 });
    view.destroy();
    engine.free();
  });

  it('is taken whole by Backspace after it and Delete before it, each one Undo step', async () => {
    const { view, engine } = await mountView('a [[Projects/Roadmap]] b');
    view.selection.selectRange(22, 22);
    input(view.dom, 'deleteContentBackward');
    expect(engine.draftText()).toBe('a  b');
    // Mod+Z off Apple (jsdom names no platform).
    key(view.dom, { key: 'z', ctrlKey: true });
    expect(engine.draftText()).toBe('a [[Projects/Roadmap]] b');
    view.selection.selectRange(2, 2);
    input(view.dom, 'deleteContentForward');
    expect(engine.draftText()).toBe('a  b');
    view.destroy();
    engine.free();
  });

  it('keeps the caret where typing before an existing ]] put it, inside the wikilink', async () => {
    const { view, engine } = await mountView('x [[]] y');
    view.selection.selectRange(4, 4);
    view.run((current) => current.replace({ start: 4, end: 4 }, 'R', 'PairedTyping'));
    expect(engine.draftText()).toBe('x [[R]] y');
    view.selection.sync();
    expect(view.selection.range()).toEqual({ start: 5, end: 5 });
    view.destroy();
    engine.free();
  });
});
