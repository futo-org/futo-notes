// Helpers shared by the note-never-emptied*.spec.ts suites, moved here verbatim from
// note-never-emptied.spec.ts.

import { expect } from '@playwright/test';

import { EDITOR, waitForEditor } from './desktopEditor';

export interface NotesHookWindow extends Window {
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

export async function storedBody(
  page: import('@playwright/test').Page,
  id: string,
): Promise<string> {
  return page.evaluate(
    (noteId) => (window as unknown as NotesHookWindow).__testNotes.readNote(noteId),
    id,
  );
}

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
export const WEB_VAULT_MODULE = '/src/lib/platform/webLocalNoteStore.ts';

export interface VaultGateWindow extends Window {
  __vaultGate: { held: boolean; release: () => void };
  __flushDraftTimes: number[];
  __keydownTimes: number[];
}

/** Hold the vault's next `method` call for note `id` until `releaseVaultCall`. */
export async function holdNextVaultCall(
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
export async function installClock(page: import('@playwright/test').Page): Promise<void> {
  await page.clock.install();
}

export async function stopClock(page: import('@playwright/test').Page): Promise<void> {
  // Jumps a second ahead first, so anything the open itself scheduled has run.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
}

export async function waitUntilVaultCallHeld(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as VaultGateWindow).__vaultGate.held);
}

export async function openStoredNote(
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

export async function writeNotes(
  page: import('@playwright/test').Page,
  notes: Record<string, string>,
): Promise<void> {
  await page.evaluate(async (entries) => {
    const w = window as unknown as NotesHookWindow;
    for (const [id, body] of entries) await w.__testNotes.writeNote(id, body);
  }, Object.entries(notes));
}
