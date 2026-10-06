import { expect, test } from '@playwright/test';

import {
  EDITOR,
  clearEditorWithKeyboard,
  openNewNote,
  setEditorMarkdown,
  typeAtCaret,
  waitForEditor,
} from './lib/desktopEditor';

/**
 * A note with content is never written back empty. → docs/spec/editor.md
 *
 * 2026-09-03: three notes in a live vault were truncated to 0 bytes. Every one
 * of them followed the same shape — the editor was holding an EMPTY document
 * for a note that had content (a hot reload had replaced the component, or the
 * parse had thrown), the session read that `''` as a deletion, and the store
 * wrote it. The two mechanisms are locked at their owning layers
 * (`MilkdownEditor.test.ts`, `noteSession.test.ts`); this is the shell wiring
 * end to end, through the real editor and the real save queue.
 *
 * NOT covered here: the webview `location.reload()` that triggered the third
 * event. The Playwright harness's vault is in-memory (webLocalNoteStore.ts), so
 * a reload wipes the notes rather than re-opening them — that leg needs the
 * real desktop app.
 */
interface NotesHookWindow extends Window {
  __testNotes: {
    writeNote: (id: string, content: string) => Promise<number>;
    readNote: (id: string) => Promise<string>;
    listNoteFiles: () => Promise<Array<{ name: string; size: number }>>;
  };
  __notesShellTest: {
    flushSave: () => Promise<void>;
    getState: () => { savePending: boolean };
    typeInEditor: (text: string) => string;
  };
}

const BODY = [
  '# How to Do Great Work',
  '',
  'If you collected lists of techniques for doing great work in a lot of',
  'different fields, what would the intersection look like?',
  '',
  '- one',
  '- two',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n');

async function storedBody(page: import('@playwright/test').Page, id: string): Promise<string> {
  return page.evaluate(
    (noteId) => (window as unknown as NotesHookWindow).__testNotes.readNote(noteId),
    id,
  );
}

test.describe('a note with content is never written back empty', () => {
  test('survives being opened, left, and re-opened byte for byte', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openNewNote(page);
    await page.evaluate(
      async ([id, body]) => {
        const w = window as unknown as NotesHookWindow;
        await w.__testNotes.writeNote(id, body);
        await w.__testNotes.writeNote('other note', 'somewhere else\n');
      },
      ['great work', BODY] as const,
    );

    // Open it, leave it for another note, come back.
    await page.evaluate(() => {
      window.location.hash = '#/note/great%20work';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('How to Do Great Work');

    await page.evaluate(() => {
      window.location.hash = '#/note/other%20note';
    });
    await expect(page.locator(EDITOR)).toContainText('somewhere else');

    await page.evaluate(() => {
      window.location.hash = '#/note/great%20work';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('How to Do Great Work');

    // Every save the shell had queued, drained.
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    expect(await storedBody(page, 'great work')).toBe(BODY);
    expect(pageErrors).toEqual([]);
  });

  /**
   * The read-back half of the first-edit rule for a note that ENDS in a block
   * that is not a paragraph (here a table). Milkdown's `trailing` plugin parks
   * an empty paragraph below it, and the first real edit used to store that as
   * a second trailing newline (RC-22; docs/spec/editor.md: a trailing empty
   * paragraph is dropped on save).
   */
  test('a real edit stores a note that ends in a table with one trailing newline', async ({
    page,
  }) => {
    await openNewNote(page);
    await page.evaluate(
      async ([id, body]) => {
        await (window as unknown as NotesHookWindow).__testNotes.writeNote(id, body);
      },
      ['ends in a table', BODY] as const,
    );
    await page.evaluate(() => {
      window.location.hash = '#/note/ends%20in%20a%20table';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('How to Do Great Work');

    await page.locator(`${EDITOR} h1`).click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    await page.waitForFunction(
      () => (window as unknown as NotesHookWindow).__notesShellTest.getState().savePending,
    );
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    // The body is already in the house style (`| --- |` delimiters), so the
    // keystroke is the only change a first edit makes.
    expect(await storedBody(page, 'ends in a table')).toBe(
      BODY.replace('Great Work', 'Great WorkX'),
    );
  });

  test('a note the user really clears is still emptied', async ({ page }) => {
    await openNewNote(page);
    await page.evaluate(async () => {
      await (window as unknown as NotesHookWindow).__testNotes.writeNote('scratch', 'delete me\n');
    });

    await page.evaluate(() => {
      window.location.hash = '#/note/scratch';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('delete me');

    /* Cleared through the shell's own edit path, which notifies the session
     * synchronously. The keyboard route to the same place is asserted below.
     *
     * The point of the assertion is the same either way: the guard that stops a
     * BLANK EDITOR from emptying a note (noteSessionChanges.ts) must not stop
     * the user from emptying one. */
    await setEditorMarkdown(page, '');
    await page.waitForFunction(
      () => (window as unknown as NotesHookWindow).__notesShellTest.getState().savePending,
    );
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    expect((await storedBody(page, 'scratch')).trim()).toBe('');
  });

  /**
   * The keyboard half of the case above, and the one a person actually
   * performs: Ctrl+A, Backspace. It reaches the session by a different route —
   * the editor's debounced change notification rather than `applyEdit` — and
   * that route used to drop the clear entirely, because the change detection it
   * ran on called a cleared note identical to the pristine empty document it
   * was still using as its baseline. → src/features/editor/milkdown/
   * documentChanges.ts
   */
  test('a note the user clears with the keyboard is emptied', async ({ page }) => {
    await openNewNote(page);
    await page.evaluate(async () => {
      await (window as unknown as NotesHookWindow).__testNotes.writeNote(
        'typed clear',
        'delete me with the keyboard\n',
      );
    });

    await page.evaluate(() => {
      window.location.hash = '#/note/typed%20clear';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('delete me with the keyboard');

    await clearEditorWithKeyboard(page);

    // The user's own deletion must reach the save queue like any other edit.
    await page.waitForFunction(
      () => (window as unknown as NotesHookWindow).__notesShellTest.getState().savePending,
    );
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    expect((await storedBody(page, 'typed clear')).trim()).toBe('');
  });

  test('clearing with the keyboard and typing again saves what was typed', async ({ page }) => {
    await openNewNote(page);
    await page.evaluate(async () => {
      await (window as unknown as NotesHookWindow).__testNotes.writeNote(
        'retyped',
        'the old body\n',
      );
    });

    await page.evaluate(() => {
      window.location.hash = '#/note/retyped';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('the old body');

    await clearEditorWithKeyboard(page);
    await typeAtCaret(page, 'x');

    await page.waitForFunction(
      () => (window as unknown as NotesHookWindow).__notesShellTest.getState().savePending,
    );
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    expect((await storedBody(page, 'retyped')).trim()).toBe('x');
  });
});

/**
 * The save queue never drops an edit the editor still holds (FB-6).
 *
 * The web vault behind the dev server is `webLocalNoteStore.ts`, and a dynamic
 * import of the same path resolves to the module instance the app itself
 * imported. Replacing one of its methods here is how these cases hold a save or
 * a read open for as long as they need, which on the desktop app is a slow
 * `flush_draft` (sync holding the store, a parked reconcile queued ahead) or a
 * slow `read_note`.
 */
const WEB_VAULT_MODULE = '/src/lib/platform/webLocalNoteStore.ts';

interface VaultGateWindow extends Window {
  __vaultGate: { held: boolean; release: () => void };
  __flushDraftTimes: number[];
  __keydownTimes: number[];
}

/** Hold the vault's next `method` call for note `id` until `releaseVaultCall`. */
async function holdNextVaultCall(
  page: import('@playwright/test').Page,
  method: 'flushDraft' | 'read',
  id: string,
): Promise<void> {
  await page.evaluate(
    async ([modulePath, name, noteId]) => {
      const { webLocalNoteStore } = await import(/* @vite-ignore */ modulePath);
      const store = webLocalNoteStore as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = store[name].bind(store);
      const w = window as unknown as VaultGateWindow;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      w.__vaultGate = { held: false, release };
      store[name] = async (...args: unknown[]) => {
        if (args[0] === noteId && !w.__vaultGate.held) {
          w.__vaultGate.held = true;
          store[name] = original;
          await gate;
        }
        return original(...args);
      };
    },
    [WEB_VAULT_MODULE, method, id] as const,
  );
}

/**
 * Hand the page's timers to the test (M15). Installed before the app boots,
 * with time flowing as usual until `stopClock`; from then on the editor's
 * 200 ms change debounce and the 500 ms save debounce fire only when the test
 * runs the clock forward, however fast or slow the machine is.
 */
async function installClock(page: import('@playwright/test').Page): Promise<void> {
  await page.clock.install();
}

async function stopClock(page: import('@playwright/test').Page): Promise<void> {
  // Jumps a second ahead first, so anything the open itself scheduled has run.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
}

async function waitUntilVaultCallHeld(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as VaultGateWindow).__vaultGate.held);
}

async function openStoredNote(
  page: import('@playwright/test').Page,
  id: string,
  visibleText: string,
): Promise<void> {
  await page.evaluate((noteId) => {
    window.location.hash = `#/note/${encodeURIComponent(noteId)}`;
  }, id);
  await waitForEditor(page);
  await expect(page.locator(EDITOR)).toContainText(visibleText);
}

async function writeNotes(
  page: import('@playwright/test').Page,
  notes: Record<string, string>,
): Promise<void> {
  await page.evaluate(async (entries) => {
    const w = window as unknown as NotesHookWindow;
    for (const [id, body] of entries) await w.__testNotes.writeNote(id, body);
  }, Object.entries(notes));
}

test.describe('an edit the editor still holds is never dropped by the save queue', () => {
  /* RC-10 (L6a-3). A save already in flight read the editor when it STARTED.
   * An edit made after that is still inside the editor's own 200 ms change
   * debounce, so nothing has told the session about it. `flush()` used to await
   * the in-flight save and return, and the switch then replaced the document
   * the edit lived in. */
  test('a note switch during an in-flight save keeps the last edit', async ({ page }) => {
    await installClock(page);
    await openNewNote(page);
    await writeNotes(page, { 'switch a': 'first body\n', 'switch b': 'the other note\n' });
    await openStoredNote(page, 'switch a', 'first body');
    await stopClock(page);

    // A reported edit whose save is then held in flight.
    await holdNextVaultCall(page, 'flushDraft', 'switch a');
    await page.evaluate(() => {
      (window as unknown as NotesHookWindow).__notesShellTest.typeInEditor('alpha');
    });
    await page.clock.runFor(200 + 500);
    await waitUntilVaultCallHeld(page);

    // One more word, and the switch. The clock is stopped, so the editor's
    // change debounce cannot report the word before the switch flushes.
    await page.evaluate(() => {
      (window as unknown as NotesHookWindow).__notesShellTest.typeInEditor('omega');
      window.location.hash = '#/note/switch%20b';
    });
    // The switch is inside its flush (begun, not yet past it), awaiting the held save.
    await page.waitForFunction(() => {
      const hook = (
        window as unknown as {
          __notesShellTest: {
            noteSwitchTimelines: () => Array<{
              noteId: string | null;
              phases: { phase: string }[];
            }>;
          };
        }
      ).__notesShellTest;
      const last = hook.noteSwitchTimelines().at(-1);
      return last?.noteId === 'switch b' && !last.phases.some((p) => p.phase === 'saveFlushed');
    });
    expect(
      await page.evaluate(
        () => (window as unknown as NotesHookWindow).__notesShellTest.getState().savePending,
      ),
      'the first save must still be in flight at the switch',
    ).toBe(true);
    await page.evaluate(() => (window as unknown as VaultGateWindow).__vaultGate.release());

    await expect(page.locator(EDITOR)).toContainText('the other note');
    await page.clock.resume();
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    const stored = await storedBody(page, 'switch a');
    expect(stored).toContain('alpha');
    expect(stored).toContain('omega');
  });

  /* RC-10 (L6a-3, second shape). The outgoing note stays mounted, visible and
   * focused while the incoming note is read. A keystroke typed then is the
   * outgoing note's; it used to be refused (the session was already "loading")
   * and then replaced by the incoming note. */
  test('a word typed into the outgoing note while the next one is read is kept', async ({
    page,
  }) => {
    await openNewNote(page);
    await writeNotes(page, { 'slow a': 'outgoing body\n', 'slow b': 'incoming body\n' });
    await openStoredNote(page, 'slow a', 'outgoing body');
    await page.locator(EDITOR).click();

    await holdNextVaultCall(page, 'read', 'slow b');
    await page.evaluate(() => {
      window.location.hash = '#/note/slow%20b';
    });
    await waitUntilVaultCallHeld(page);

    await page.keyboard.type('zqtypedq', { delay: 20 });
    await expect(page.locator(EDITOR)).toContainText('zqtypedq');
    await page.evaluate(() => (window as unknown as VaultGateWindow).__vaultGate.release());

    await expect(page.locator(EDITOR)).toContainText('incoming body');
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    expect(await storedBody(page, 'slow a')).toContain('zqtypedq');
    expect(await storedBody(page, 'slow b')).toBe('incoming body\n');
  });

  /* RC-28 (L6a-6). A save driven by a READ — a title blur, a sync completion,
   * a window close — takes an edit the editor has not reported yet. An Undo
   * back to the document as it was loaded then looked like the load's own
   * echo and was never reported, so the undone edit stayed on disk. */
  test('an Undo after a read-driven save of an unreported edit is saved too', async ({ page }) => {
    await installClock(page);
    await openNewNote(page);
    await writeNotes(page, { 'undo after read': 'loaded body\n' });
    await openStoredNote(page, 'undo after read', 'loaded body');
    await page.locator(EDITOR).click();
    await stopClock(page);

    // With the clock stopped, the edit and its Undo both land inside the
    // editor's change debounce, whatever the machine's speed.
    await page.keyboard.type('q');
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());
    expect(await storedBody(page, 'undo after read')).toContain('q');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator(EDITOR)).not.toContainText('q');
    expect(
      await page.evaluate(
        () => (window as unknown as NotesHookWindow).__notesShellTest.getState().savePending,
      ),
      'the editor must not have reported either keystroke yet',
    ).toBe(false);

    // Past the editor's 200 ms change debounce and the 500 ms save debounce,
    // with nothing flushing on the test's behalf.
    await page.clock.runFor(200 + 500 + 100);
    await expect
      .poll(() => storedBody(page, 'undo after read'), { timeout: 3000 })
      .toBe('loaded body\n');
  });

  /* RC-26 (L7-linux-02, maintainer decision 5A). The body save was a pure
   * trailing debounce behind the editor's own trailing debounce, so a steady
   * typist was saved only when they paused, and a crash mid-burst lost the
   * whole burst. A save now lands every ~2 s while typing continues. */
  test('continuous typing is saved within about two seconds, without a pause', async ({ page }) => {
    await installClock(page);
    await openNewNote(page);
    await writeNotes(page, { 'steady typist': 'start\n' });
    await openStoredNote(page, 'steady typist', 'start');
    await page.locator(EDITOR).click();
    await stopClock(page);

    await page.evaluate(async (modulePath) => {
      const { webLocalNoteStore } = await import(/* @vite-ignore */ modulePath);
      const store = webLocalNoteStore as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = store.flushDraft.bind(store);
      const w = window as unknown as VaultGateWindow;
      w.__flushDraftTimes = [];
      w.__keydownTimes = [];
      store.flushDraft = (...args: unknown[]) => {
        w.__flushDraftTimes.push(performance.now());
        return original(...args);
      };
      document.addEventListener('keydown', () => w.__keydownTimes.push(performance.now()), true);
    }, WEB_VAULT_MODULE);

    // 4 s of typing, one keystroke every 100 ms of page time: no gap the
    // editor's 200 ms change debounce could fire in, however slow the machine.
    for (const key of 'zq steady words typed without a pause qz') {
      await page.keyboard.press(key === ' ' ? 'Space' : key);
      await page.clock.runFor(100);
    }

    const timing = await page.evaluate(() => {
      const w = window as unknown as VaultGateWindow;
      const keys = w.__keydownTimes;
      let longestGap = 0;
      for (let i = 1; i < keys.length; i += 1)
        longestGap = Math.max(longestGap, keys[i] - keys[i - 1]);
      return {
        longestGap,
        typedFor: keys[keys.length - 1] - keys[0],
        firstSaveAfter: w.__flushDraftTimes.length ? w.__flushDraftTimes[0] - keys[0] : null,
      };
    });
    expect(
      timing.longestGap,
      'the typing must be continuous for this case to mean anything',
    ).toBeLessThan(200);
    expect(timing.typedFor).toBeGreaterThan(3000);
    expect(timing.firstSaveAfter, 'no save landed while the typist kept typing').not.toBeNull();
    // The editor reports after 1.5 s of unbroken editing; the save follows 500 ms later.
    expect(timing.firstSaveAfter!).toBeLessThanOrEqual(2100);
    expect(timing.firstSaveAfter!).toBeLessThan(timing.typedFor);
  });
});

/**
 * RC-17 (L6a-4). CRITICAL never-emptied, under a serializer that throws.
 *
 * No natural document is known to make serialization throw, so the throw is
 * injected into the served `serializationLoop.ts`'s `serialize` seam for any
 * document carrying a synthetic marker. The tag bar replaces the whole note (`applyEdit`) and then
 * nothing can serialize it: `getContent()` used to fall back to `''`, which the
 * save pipeline could not tell from a real clear, and the note was written
 * empty.
 */
test('a tag added to a note the serializer cannot handle never writes the note empty', async ({
  page,
}) => {
  const POISON = 'zqserializerfaultzq';
  let injected = false;
  await page.route('**/src/features/editor/milkdown/serializationLoop.ts*', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const poisoned = source.replace(
      /function serialize\(doc\)\s*\{/,
      (head) =>
        `${head} if (doc.textContent.includes(${JSON.stringify(POISON)})) throw new Error('injected serializer fault');`,
    );
    injected = poisoned !== source;
    await route.fulfill({ response, body: poisoned });
  });

  await openNewNote(page);
  expect(injected, 'the serializer fault was never injected').toBe(true);
  const body = `a note with a body ${POISON}\n`;
  await writeNotes(page, { 'tagged note': body });
  await openStoredNote(page, 'tagged note', 'a note with a body');

  await page.locator('.tag-add-btn').click();
  await page.locator('.tag-input').fill('zqtag');
  await page.locator('.tag-input').press('Enter');
  await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

  expect(await storedBody(page, 'tagged note')).not.toBe('');
  expect((await storedBody(page, 'tagged note')).length).toBeGreaterThan(0);
});
