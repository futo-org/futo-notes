// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SidebarTagView from './SidebarTagView.svelte';
import type { NotePreview } from '$shared/types/note';

function note(id: string, tags: string[]): NotePreview {
  return { id, title: id, preview: '', modificationTime: 0, tags };
}

describe('SidebarTagView', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
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

  it('mounts with a raw notes array without exceeding effect depth', () => {
    expect(() => {
      app = mount(SidebarTagView, {
        target,
        props: {
          notes: [note('a', ['project']), note('b', ['project', 'ideas'])],
          selectedId: null,
          onselect: () => {},
        },
      });
      flushSync();
    }).not.toThrow();

    const headers = target.querySelectorAll('.sidebar-tag-header');
    expect(headers.length).toBe(2); // #ideas, #project
  });

  it('clicking a tag header expands its notes (alphabetical)', () => {
    app = mount(SidebarTagView, {
      target,
      props: {
        notes: [note('zebra', ['project']), note('alpha', ['project'])],
        selectedId: null,
        onselect: () => {},
      },
    });
    flushSync();

    const header = [...target.querySelectorAll('.sidebar-tag-header')].find((h) =>
      h.textContent?.includes('#project'),
    ) as HTMLButtonElement;
    expect(header).toBeTruthy();

    header.click();
    flushSync();

    const items = [...target.querySelectorAll('.sidebar-tag-note')].map((el) =>
      el.textContent?.trim(),
    );
    expect(items).toEqual(['alpha', 'zebra']);

    header.click();
    flushSync();
    expect(target.querySelectorAll('.sidebar-tag-note').length).toBe(0);
  });
});
