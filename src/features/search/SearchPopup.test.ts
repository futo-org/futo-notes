// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { NotePreview } from '$shared/types/note';

const searchMock = vi.fn();
vi.mock('$features/notes/notes.svelte', () => ({
  search: (query: string) => searchMock(query),
}));

import SearchPopup from './SearchPopup.svelte';

function makeNote(id: string, preview = ''): NotePreview {
  return {
    id,
    title: id,
    preview,
    tags: [],
    modificationTime: 0,
  } as unknown as NotePreview;
}

describe('SearchPopup', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;
  let onclose: ReturnType<typeof vi.fn>;
  let onselect: ReturnType<typeof vi.fn>;

  function mountPopup(): void {
    app = mount(SearchPopup, { target, props: { onclose, onselect } });
    flushSync();
  }

  async function resultButtons(): Promise<HTMLButtonElement[]> {
    await vi.waitFor(() => {
      if (!target.querySelector('.search-result-item')) throw new Error('no results yet');
    });
    return Array.from(target.querySelectorAll('.search-result-item'));
  }

  function setQuery(value: string): void {
    const input = target.querySelector('.search-input') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
  }

  beforeEach(() => {
    onclose = vi.fn();
    onselect = vi.fn();
    searchMock.mockReset();
    searchMock.mockResolvedValue([]);
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (app) {
      unmount(app);
      app = null;
    }
    target.remove();
  });

  it('caps the empty-query result list at the 8 most recent notes', async () => {
    // search('') returns every note most-recent-first; the popup owns the 8-cap
    // (search.md "eight recent notes").
    searchMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ note: makeNote(`note-${i}`) })),
    );
    mountPopup();

    const rows = await resultButtons();
    expect(rows).toHaveLength(8);
    expect(searchMock).toHaveBeenCalledWith('');
  });

  it('passes the modifier state of a result click through to onselect (new-tab path)', async () => {
    searchMock.mockResolvedValue([{ note: makeNote('alpha') }]);
    mountPopup();

    const [row] = await resultButtons();
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));

    expect(onselect).toHaveBeenCalledTimes(1);
    const [id, event] = onselect.mock.calls[0];
    expect(id).toBe('alpha');
    expect((event as MouseEvent).ctrlKey).toBe(true);
  });

  it('opens a result on middle-click (auxclick button 1)', async () => {
    searchMock.mockResolvedValue([{ note: makeNote('alpha') }]);
    mountPopup();

    const [row] = await resultButtons();
    row.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));

    expect(onselect).toHaveBeenCalledTimes(1);
    expect(onselect.mock.calls[0][0]).toBe('alpha');
  });

  it('shows a folder badge only for foldered notes', async () => {
    searchMock.mockResolvedValue([
      { note: makeNote('Projects/plan') },
      { note: makeNote('loose-note') },
    ]);
    mountPopup();

    const rows = await resultButtons();
    const badge = rows[0].querySelector('[data-testid="folder-badge"]');
    expect(badge?.textContent).toBe('Projects');
    expect(rows[1].querySelector('[data-testid="folder-badge"]')).toBeNull();
  });

  it('clear button resets the query and disappears', async () => {
    mountPopup();
    setQuery('needle');

    const clear = target.querySelector('.search-clear') as HTMLButtonElement;
    expect(clear).not.toBeNull();
    clear.click();
    flushSync();

    const input = target.querySelector('.search-input') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(target.querySelector('.search-clear')).toBeNull();
  });

  it('shows the "No notes found" empty state for a query with no matches', async () => {
    vi.useFakeTimers();
    try {
      searchMock.mockResolvedValue([]);
      mountPopup();
      setQuery('zzz-no-match');

      // Queries debounce ~100 ms before hitting the store (search.md).
      await vi.advanceTimersByTimeAsync(150);
      flushSync();

      expect(searchMock).toHaveBeenCalledWith('zzz-no-match');
      expect(target.querySelector('.search-empty')?.textContent).toBe('No notes found');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape closes the popup from the panel', async () => {
    mountPopup();
    const panel = target.querySelector('.search-panel') as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
