// @vitest-environment jsdom
/**
 * The selection toolbar's URL field belongs to the note it opened on.
 *
 * Same 2026-09-19 family as `imageInsertTarget.ts` and the Link prompt's own
 * `linkPrompt/noteSwitch.test.ts`: the field stays open while the user types,
 * a keyboard note switch moves no DOM focus and fires no `pointerdown`, and
 * `applyLink` then wrote the URL onto the caret in a note the user never
 * opened the field on. → docs/spec/editor.md "Interactive elements"
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';

import { withoutLeakedCtxTimers } from '../__fixtures__/noLeakedCtxTimers';

interface EditorHandle {
  openNote: (text: string) => void;
  getContent: () => string | undefined;
}

const MilkdownEditor = (await import('../MilkdownEditor.svelte')).default;

let target: HTMLElement;
let handle: EditorHandle;

/** The bar is body-mounted, so its URL field is not in the editor's subtree. */
function urlField(): HTMLInputElement | null {
  return document.body.querySelector('.futo-selection-toolbar input.futo-selection-toolbar-url');
}

function linkButton(): HTMLElement | null {
  return document.body.querySelector('.futo-selection-toolbar [aria-label="Link"]');
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

describe('the selection toolbar URL field across a note switch', () => {
  it('closes rather than applying the link to the note the user moved to', async () => {
    handle.openNote('note A body');
    const view = target.querySelector('.ProseMirror') as HTMLElement;
    view.focus();
    // A non-empty text selection is what puts the bar on screen.
    const range = document.createRange();
    range.selectNodeContents(view.firstChild as Node);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    await vi.waitFor(() => expect(linkButton()).not.toBeNull());
    linkButton()!.click();
    await vi.waitFor(() => expect(urlField()).not.toBeNull());

    handle.openNote('note B body');

    await vi.waitFor(() => expect(urlField()).toBeNull());
    expect(handle.getContent()).toBe('note B body');
  });
});
