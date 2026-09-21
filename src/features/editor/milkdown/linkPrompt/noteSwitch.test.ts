// @vitest-environment jsdom
/**
 * The Link URL prompt belongs to the note it opened on.
 *
 * The sibling of the delayed-image bug (`imageInsertTarget.ts`), found in the
 * same 2026-09-19 sweep. The prompt floats over the editor holding the
 * ORIGINATING note's positions, and this component is reused across notes. A
 * keyboard note switch (Ctrl+Tab and friends, registerNotesShellShortcuts.ts)
 * moves no DOM focus and fires no `pointerdown`, so neither of the prompt's
 * two dismissal paths ran: submitting afterwards dispatched `tr.insert(pos, …)`
 * — or a `removeMark`/`addMark` over the old note's offsets — against the NEW
 * note's document. → docs/spec/editor.md "Images" / "Interactive elements"
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';

import { withoutLeakedCtxTimers } from '../__fixtures__/noLeakedCtxTimers';

interface EditorHandle {
  openNote: (text: string) => void;
  getContent: () => string | undefined;
  exec: (commandId: string) => boolean;
}

const MilkdownEditor = (await import('../MilkdownEditor.svelte')).default;

let target: HTMLElement;
let handle: EditorHandle;

/** The prompt is body-mounted, not inside the editor's own subtree. */
function promptInput(): HTMLInputElement | null {
  return document.body.querySelector('input.futo-selection-toolbar-url');
}

/** Types a URL into the open prompt and presses Enter, as a user would. */
function submitPrompt(input: HTMLInputElement, url: string): void {
  input.value = url;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

beforeEach(async () => {
  document.body.innerHTML = '';
  target = document.createElement('div');
  document.body.appendChild(target);
  await withoutLeakedCtxTimers(async () => {
    handle = mount(MilkdownEditor, {
      target,
      props: { content: '', onchange: () => {} },
    }) as unknown as EditorHandle;
    await vi.waitFor(() => expect(target.querySelector('.ProseMirror')).not.toBeNull());
  });
});

describe('a Link URL prompt left open across a note switch', () => {
  it('is taken down, so nothing can be written into the note the user moved to', async () => {
    handle.openNote('note A body');
    handle.exec('link');
    await vi.waitFor(() => expect(promptInput()).not.toBeNull());
    const input = promptInput()!;

    handle.openNote('note B body');

    expect(promptInput()).toBeNull();
    submitPrompt(input, 'https://example.com');
    expect(handle.getContent()).toBe('note B body');
  });

  it('still inserts the link when the note has not changed', async () => {
    handle.openNote('note A body');
    handle.exec('link');
    await vi.waitFor(() => expect(promptInput()).not.toBeNull());

    submitPrompt(promptInput()!, 'https://example.com');

    await vi.waitFor(() => expect(handle.getContent()).toContain('https://example.com'));
  });
});
