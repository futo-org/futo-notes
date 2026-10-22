// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNoteTitleController } from './createNoteTitleController.svelte';

function controllerFor(input: HTMLTextAreaElement) {
  return createNoteTitleController({
    setTitle: vi.fn(),
    hasDuplicateTitle: () => false,
    scheduleSave: vi.fn(),
    flushSave: vi.fn(),
    focusEditor: vi.fn(),
    getTextarea: () => input,
  });
}

describe('focusing an untitled title', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a character typed before the next frame', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const input = document.createElement('textarea');
    input.value = 'Untitled';
    const controller = controllerFor(input);

    controller.handleFocus({ currentTarget: input } as unknown as FocusEvent);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Untitled'.length]);

    // The first keystroke replaces the selection; the frame runs after it.
    input.setRangeText('T', 0, input.value.length, 'end');
    for (const frame of frames.splice(0)) frame(0);

    expect(input.value).toBe('T');
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 1]);
  });
});
