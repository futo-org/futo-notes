// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { EditorKeys, formatShortcut } from './keys';
import type { EditorView } from './view';

describe('formatShortcut', () => {
  const key = (init: KeyboardEventInit, altGraph = false) => {
    const event = new KeyboardEvent('keydown', init);
    event.getModifierState = (name: string) => altGraph && name === 'AltGraph';
    return event;
  };

  it('reads Mod+B, I and E, Mod+Alt+X and Mod+Alt+0…6, Cmd on Apple and Ctrl elsewhere', () => {
    expect(formatShortcut(key({ key: 'b', metaKey: true }), true)).toEqual({ format: 'Bold' });
    expect(formatShortcut(key({ key: 'i', ctrlKey: true }), false)).toEqual({ format: 'Italic' });
    expect(formatShortcut(key({ key: 'e', metaKey: true }), true)).toEqual({ format: 'Code' });
    expect(formatShortcut(key({ key: 'b', ctrlKey: true }), true)).toBeNull();
    expect(formatShortcut(key({ key: 'b', metaKey: true }), false)).toBeNull();
    // Option rewrites the character on a Mac keyboard: the key's place names it.
    const strike = key({ key: '≈', code: 'KeyX', metaKey: true, altKey: true });
    expect(formatShortcut(strike, true)).toEqual({ format: 'Strike' });
    const heading = key({ key: '™', code: 'Digit2', metaKey: true, altKey: true });
    expect(formatShortcut(heading, true)).toEqual({ block: { Heading: 2 } });
    const text = key({ key: '0', code: 'Digit0', ctrlKey: true, altKey: true });
    expect(formatShortcut(text, false)).toEqual({ block: { Heading: 0 } });
    const ordered = key({ key: '¶', code: 'Digit7', metaKey: true, altKey: true });
    expect(formatShortcut(ordered, true)).toEqual({ block: 'OrderedList' });
    expect(formatShortcut(key({ key: '8', ctrlKey: true, altKey: true }), false)).toEqual({
      block: 'BulletList',
    });
    expect(formatShortcut(key({ key: '9', ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  it('is Quote with Shift and B, else none with Shift held, nor an AltGr chord', () => {
    expect(formatShortcut(key({ key: 'B', metaKey: true }), true)).toEqual({ format: 'Bold' });
    const quote = { block: 'Quote' };
    expect(formatShortcut(key({ key: 'b', metaKey: true, shiftKey: true }), true)).toEqual(quote);
    expect(formatShortcut(key({ key: 'B', ctrlKey: true, shiftKey: true }), false)).toEqual(quote);
    expect(formatShortcut(key({ key: 'I', metaKey: true, shiftKey: true }), true)).toBeNull();
    const altGraph = key({ key: 'x', code: 'KeyX', ctrlKey: true, altKey: true }, true);
    expect(formatShortcut(altGraph, false)).toBeNull();
  });
});

describe('EditorKeys', () => {
  it('outdents on Shift+Tab when WebKitGTK names the key Unidentified', () => {
    const engine = { paragraphKey: vi.fn() };
    const selection = { from: 0, to: 0 };
    const view = {
      selection: { range: () => selection },
      codeHeader: { focusLanguageFromCode: () => false },
      completion: { keyDown: () => false },
      slashMenu: { keyDown: () => false },
      run: (edit: (engine: unknown) => void) => edit(engine),
    } as unknown as EditorView;
    const event = new KeyboardEvent('keydown', {
      key: 'Unidentified',
      code: 'Tab',
      shiftKey: true,
      cancelable: true,
    });
    new EditorKeys(view).keyDown(event);
    expect(engine.paragraphKey).toHaveBeenCalledWith(selection, 'ShiftTab');
    expect(event.defaultPrevented).toBe(true);
  });
});
