// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { runPuppetCommand } from '$app/puppet/puppetInspector';
import type { NotePreview } from '$shared/types/note';

import DrawerSidebar from './DrawerSidebar.svelte';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    disconnect(): void {}
  },
);

const note = (id: string): NotePreview => ({
  id,
  title: id.split('/').pop()!,
  preview: '',
  modificationTime: 0,
  tags: [],
});

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
});

it('StartRenaming opens the inline field the menu’s Rename opens', () => {
  const target = document.body.appendChild(document.createElement('div'));
  app = mount(DrawerSidebar, {
    target,
    props: {
      notes: [note('reading/one'), note('inbox')],
      activeNoteId: null,
      view: 'notes',
      showCollapse: false,
      showResize: false,
      onselectview: () => {},
      onselectnote: () => {},
      onrunwithactivenotelock: (operation) => operation(),
      onnoteidsrenamed: () => {},
      onnoteidsdeleted: () => {},
      onactivenotedeleted: () => {},
      onactivenotemoved: () => {},
      onnewnote: () => {},
      onnewnoteinfolder: () => {},
      onhome: () => {},
      onsettings: () => {},
      onopenlicense: () => {},
      oncollapse: () => {},
      onopensearch: () => {},
      onresize: () => {},
      onresizeend: () => {},
    },
  });
  flushSync();
  const doVerb = (verb: string, args: Record<string, unknown>) =>
    runPuppetCommand('do', { verb, args });

  expect(doVerb('StartRenamingFolder', { path: 'nothing' }).status).toBe(400);
  expect(doVerb('StartRenamingNote', { noteId: 'nothing' }).status).toBe(400);
  expect(doVerb('StartRenamingFolder', { path: 'reading' }).status).toBe(200);
  flushSync();
  expect(target.querySelector<HTMLInputElement>('.folder-tree-scroll input')?.value).toBe(
    'reading',
  );
  expect(doVerb('SetNewName', { name: 'saved' }).status).toBe(200);
});
