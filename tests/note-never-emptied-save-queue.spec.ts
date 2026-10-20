// Part of the note-never-emptied suite: the invariant and its history are described in
// note-never-emptied.spec.ts.

import { expect, test } from '@playwright/test';
import { EDITOR, openNewNote } from './lib/desktopEditor';
import {
  NotesHookWindow,
  storedBody,
  WEB_VAULT_MODULE,
  type VaultGateWindow,
  holdNextVaultCall,
  installClock,
  stopClock,
  waitUntilVaultCallHeld,
  openStoredNote,
  writeNotes,
} from './lib/noteNeverEmptied';

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
