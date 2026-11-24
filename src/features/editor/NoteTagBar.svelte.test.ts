// @vitest-environment jsdom
/* The tag bar hands each edit to the note's engine edits (headerTagEdits.ts), and a tag being
 * typed belongs to the note it was started on. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { desktopLocalization } from '$shared/localization';
import type { HeaderTagEdits } from './desktop/headerTagEdits';
import NoteTagBar from './NoteTagBar.svelte';

let target: HTMLDivElement;
let app: ReturnType<typeof mount> | null = null;

const recordingEdits = (): HeaderTagEdits => ({ add: vi.fn(), remove: vi.fn() });

function render(props: {
  tags: string[];
  edits: HeaderTagEdits | null;
  onreturntonote?: () => void;
}): HTMLElement {
  app = mount(NoteTagBar, { target, props: { ...props, notes: [], active: true } });
  flushSync();
  return target;
}

function typeTag(bar: HTMLElement, name: string, key: string): void {
  bar.querySelector<HTMLButtonElement>('.tag-add-btn')!.click();
  flushSync();
  const input = bar.querySelector<HTMLInputElement>('.tag-input')!;
  input.value = name;
  input.dispatchEvent(new Event('input'));
  flushSync();
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  flushSync();
}

beforeEach(() => {
  desktopLocalization.setSelectedLanguageTag('en');
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target.remove();
  desktopLocalization.setSelectedLanguageTag(null);
});

it('commits a typed tag with Enter or a comma through the note’s edits', () => {
  for (const key of ['Enter', ',']) {
    const edits = recordingEdits();
    typeTag(render({ tags: [], edits }), 'Recipes', key);
    expect(edits.add).toHaveBeenCalledExactlyOnceWith('recipes');
    unmount(app!);
    app = null;
  }
});

it('keeps the field, emptied, after a tag, and returns to the note on Escape or an empty Enter', () => {
  for (const key of ['Enter', 'Escape']) {
    const edits = recordingEdits();
    const onreturntonote = vi.fn();
    const bar = render({ tags: [], edits, onreturntonote });
    typeTag(bar, 'Recipes', 'Enter');
    const input = bar.querySelector<HTMLInputElement>('.tag-input')!;
    expect(input.value).toBe('');
    expect(onreturntonote).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    flushSync();
    expect(bar.querySelector('.tag-input')).toBeNull();
    expect(onreturntonote).toHaveBeenCalledOnce();
    expect(edits.add).toHaveBeenCalledExactlyOnceWith('recipes');
    unmount(app!);
    app = null;
  }
});

it('removes a chip’s tag through the note’s edits', () => {
  const edits = recordingEdits();
  const bar = render({ tags: ['#work', '#home'], edits });
  bar.querySelectorAll<HTMLButtonElement>('.tag-pill-remove')[1].click();
  expect(edits.remove).toHaveBeenCalledExactlyOnceWith('#home');
});

it('closes a tag being typed when another note opens, adding it to neither', () => {
  const first = recordingEdits();
  const second = recordingEdits();
  const props = $state({ tags: [] as string[], edits: first as HeaderTagEdits | null });
  app = mount(NoteTagBar, {
    target,
    props: {
      get tags() {
        return props.tags;
      },
      get edits() {
        return props.edits;
      },
      notes: [],
      active: true,
    },
  });
  flushSync();
  target.querySelector<HTMLButtonElement>('.tag-add-btn')!.click();
  flushSync();
  props.edits = second;
  flushSync();
  expect(target.querySelector('.tag-input')).toBeNull();
  expect(first.add).not.toHaveBeenCalled();
  expect(second.add).not.toHaveBeenCalled();
});

it('offers no add or remove with no note open', () => {
  const bar = render({ tags: [], edits: null });
  expect(bar.querySelector('button')).toBeNull();
});
