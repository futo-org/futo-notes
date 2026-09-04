// @vitest-environment jsdom
/**
 * The editor's data-safety contract: what it reports for a note it is NOT
 * holding.
 *
 * 2026-09-03 DATA LOSS. Three notes in a live vault were overwritten with 0
 * bytes. Two of them were open while a hot-module reload replaced this
 * component — the new instance mounts EMPTY under a session that still holds
 * the note. The third had markdown the parser threw on, which left the editor
 * with an empty document and the reader with a blank page. In all three the
 * component answered `getContent()` with `''`, the save pipeline read that as
 * "the user deleted everything", and the Rust store truncated the file
 * (`flush_draft` writes whatever it is given when the base still matches disk).
 *
 * The rule these lock: an empty document the editor never loaded is never
 * reported as the note. → docs/spec/editor.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

/**
 * Markdown whose parse throws. Real notes that do this exist — a table cell
 * that opened a wikilink token it could not close was one, fixed in d402d0aa —
 * but none is guaranteed to survive the next parser fix, and the contract has
 * to hold for the NEXT one. So the throw is injected at the one call the
 * component makes to parse a whole document.
 */
const POISONED = '# a note this build cannot parse\n\nbody\n';

vi.mock('@milkdown/kit/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@milkdown/kit/utils')>();
  return {
    ...actual,
    replaceAll: (markdown: string, ...rest: unknown[]) => {
      if (markdown === POISONED) {
        return () => {
          throw new Error('Cannot close tableHeader: a different token (wikilink) is open');
        };
      }
      return (actual.replaceAll as (...args: unknown[]) => unknown)(markdown, ...rest);
    },
  };
});

interface EditorHandle {
  openNote: (text: string) => void;
  setContent: (text: string) => void;
  applyEdit: (text: string) => void;
  getContent: () => string | undefined;
}

let changes: string[] = [];
let target: HTMLElement;
let handle: EditorHandle;

/** Mounts a fresh editor and waits for Milkdown's async `create()` to land. */
async function mountEditor(): Promise<void> {
  const MilkdownEditor = (await import('./MilkdownEditor.svelte')).default;
  changes = [];
  target = document.createElement('div');
  document.body.appendChild(target);
  handle = mount(MilkdownEditor, {
    target,
    props: {
      content: '',
      onchange: (content: string) => {
        changes.push(content);
      },
    },
  }) as unknown as EditorHandle;
  await vi.waitFor(() => expect(target.querySelector('.ProseMirror')).not.toBeNull());
}

function editable(): HTMLElement {
  const element = target.querySelector('.ProseMirror');
  if (!(element instanceof HTMLElement)) throw new Error('no editable');
  return element;
}

/** The listener plugin debounces `markdownUpdated` by 200 ms. */
function afterChangeDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 350));
}

beforeEach(async () => {
  document.body.innerHTML = '';
  // @milkdown/plugin-block hit-tests the block under the pointer on every
  // synthetic pointermove the caret dispatches; jsdom has no hit testing.
  document.elementFromPoint = () => null;
  await mountEditor();
  return async () => {
    await unmount(handle as never);
  };
});

describe('an editor holding no note', () => {
  it('reports nothing at all, not an empty note', () => {
    // A freshly mounted component — which is what a hot reload, a `{#key}`, or
    // an `{#if}` around the editor leaves behind while a note is open. `''`
    // here is what the save pipeline wrote over three real notes.
    expect(handle.getContent()).toBeUndefined();
  });

  it('reports an empty string once a brand-new note has been opened', () => {
    handle.openNote('');
    expect(handle.getContent()).toBe('');
  });
});

describe('a note whose parse throws', () => {
  it('reports the host bytes it was given, never the empty document', () => {
    handle.openNote(POISONED);

    expect(editable().textContent).toBe('');
    expect(handle.getContent()).toBe(POISONED);
  });

  it('emits no change, so nothing reaches the save queue', async () => {
    handle.openNote(POISONED);
    await afterChangeDebounce();

    expect(changes).toEqual([]);
  });

  it('says so, and goes read-only rather than showing a blank editable page', async () => {
    handle.openNote(POISONED);
    await tick();

    expect(target.querySelector('[role="alert"]')?.textContent).toContain('could not be displayed');
    expect(editable().getAttribute('contenteditable')).toBe('false');
  });

  it('refuses chrome edits computed from a document it never loaded', () => {
    handle.openNote(POISONED);
    handle.applyEdit('#tag\n\nsomething else\n');

    expect(handle.getContent()).toBe(POISONED);
    expect(changes).toEqual([]);
  });

  it('recovers completely when the next note parses', async () => {
    handle.openNote(POISONED);
    await tick();
    handle.openNote('# fine\n\nbody\n');
    await tick();

    expect(handle.getContent()).toBe('# fine\n\nbody\n');
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(editable().getAttribute('contenteditable')).toBe('true');
  });
});
