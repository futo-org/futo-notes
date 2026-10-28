// @vitest-environment jsdom
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import Modal from '$shared/dialogs/Modal.svelte';
import { localizedText } from '$shared/localization';

import { mountEditor } from './puppetEditor.fixture';
import { describeElement } from './puppetElements';
import { runPuppetCommand } from './puppetInspector';
import { errorOf, run } from './puppetInspector.fixture';
import { puppetVerb, registerPuppetVerbs } from './puppetRegistry';

describe('a modal dialog', () => {
  const verbNames = () =>
    (runPuppetCommand('actions', {}).body as { actions: Array<{ name: string }> }).actions.map(
      (action) => action.name,
    );
  const openDialog = (verbs?: () => ReturnType<typeof puppetVerb>[]) => {
    const dialog = mount(Modal, {
      target: document.body,
      props: {
        ondismiss: () => {},
        verbs,
        children: createRawSnippet(() => ({ render: () => '<p>Delete it?</p>' })),
      },
    });
    flushSync();
    return dialog;
  };

  // Settings open, `Select` still moved the caret in the note behind it and took focus there.
  it('leaves only its own verbs and the window shortcuts, and says why the rest refuse', async () => {
    await mountEditor();
    registerPuppetVerbs(() => [puppetVerb('OpenNote', { noteId: 'string' }, () => {})]);
    registerPuppetVerbs(() => [puppetVerb('NewTab', {}, () => {})], { windowShortcuts: true });
    const dialog = openDialog(() => [puppetVerb('ConfirmDialog', {}, () => {})]);
    try {
      expect(verbNames()).toEqual(['ScrollBy', 'NewTab', 'DismissDialog', 'ConfirmDialog']);
      for (const [verb, args] of [
        ['Select', { find: 'brown' }],
        ['OpenNote', { noteId: 'brown fox' }],
      ] as const) {
        expect(run(verb, args)).toEqual({
          status: 404,
          body: {
            ok: false,
            error: `${verb} is behind the open dialog, which a person closes first`,
          },
        });
      }
      expect(errorOf(run('Frobnicate'))).toBe('no such verb on this screen: Frobnicate');

      // A dialog over the dialog leaves only its own.
      const inner = openDialog();
      try {
        expect(verbNames()).toEqual(['ScrollBy', 'NewTab', 'DismissDialog']);
      } finally {
        unmount(inner);
      }
      flushSync();
      expect(verbNames()).toContain('ConfirmDialog');
    } finally {
      unmount(dialog);
    }
    flushSync();
    expect(verbNames()).toEqual(expect.arrayContaining(['OpenNote', 'Select', 'NewTab']));
    expect(verbNames()).not.toContain('DismissDialog');
  });

  it('names no verb it hides on a row behind it', async () => {
    await mountEditor();
    const undo = document.createElement('button');
    undo.setAttribute('aria-label', localizedText('editor.toolbar.undo'));
    document.body.append(undo);
    expect(describeElement(undo).verb).toBe('Undo');
    const dialog = openDialog();
    try {
      expect(describeElement(undo).verb).toBeUndefined();
    } finally {
      unmount(dialog);
    }
  });
});
