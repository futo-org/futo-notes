import { test, expect, type Page } from '@playwright/test';

import { EDITOR, editorMarkdown, openNewNote, setEditorMarkdown } from './lib/desktopEditor';

/**
 * Dropping a file from the OS onto the editor.
 *
 * SCOPE, and the honest limit. Playwright cannot perform a real OS drag — no
 * browser automation protocol can hand the page a file the way a file manager
 * does. A dispatched `DragEvent` carrying a real `DataTransfer` with a real
 * `File` is the accepted ceiling here, the same one `tests/image-paste.spec.ts`
 * takes for the clipboard: it goes through ProseMirror's own `drop` handling
 * and reaches the editor's `handleDrop` prop exactly as a genuine drop would.
 *
 * What runs here is the WEB build, which has no vault to write into
 * (`saveImageBytes` is absent), so the assertions are the two that hold on
 * every host and are the ones that protect the note:
 *
 *   1. A drop carrying FILES is claimed — `defaultPrevented`. This is the
 *      load-bearing one. The browser's default for an unclaimed file drop is to
 *      NAVIGATE the webview to that file, which on desktop tears the running
 *      app down mid-edit; and it must hold whether or not the file was an image.
 *   2. A drop carrying no files is NOT claimed, so the editor's own block drag
 *      keeps working.
 *
 * The vault write and the inserted `![](…)` need a `PlatformFS` that can write,
 * which no browser has — those are covered against a mocked one in
 * `src/features/editor/imageInsert.test.ts`. The LINUX path is different again:
 * the drop never reaches the page at all (wry claims it) and arrives on the
 * window through `PlatformFS.onFileDrop`, which no browser test can exercise.
 */

interface DropFile {
  name: string;
  type: string;
  bytes: number[];
}

/** Dispatch a `drop` at the editor's centre and report whether it was claimed. */
async function dropOnto(page: Page, files: DropFile[], text?: string): Promise<boolean> {
  await page.locator(EDITOR).click();
  return page.evaluate(
    ({ selector, dropped, droppedText }) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('editor not found');

      const transfer = new DataTransfer();
      if (droppedText !== undefined) transfer.setData('text/plain', droppedText);
      for (const file of dropped) {
        transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
      }

      // ProseMirror resolves the drop point from the event's coordinates and
      // bails out before consulting `handleDrop` if they hit nothing, so the
      // drop has to land on real text.
      const box = element.getBoundingClientRect();
      const event = new DragEvent('drop', {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + 8,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { selector: EDITOR, dropped: files, droppedText: text },
  );
}

const PNG = { name: 'holiday.png', type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] };
const MARKDOWN = { name: 'shopping.md', type: 'text/markdown', bytes: [0x23, 0x20, 0x68] };

test.describe('Dropping a file onto the editor', () => {
  test('an image drop is claimed, so the webview cannot navigate away from the app', async ({
    page,
  }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'some text');

    expect(await dropOnto(page, [PNG])).toBe(true);
  });

  test('a non-image drop is claimed too, and inserts nothing', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'some text');

    expect(await dropOnto(page, [MARKDOWN])).toBe(true);

    const markdown = await editorMarkdown(page);
    expect(markdown).not.toContain('![](');
    expect(markdown).not.toContain('shopping.md');
    expect(markdown).toContain('some text');
  });

  test('a drop with no image storage leaves the note intact', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'some text');

    await dropOnto(page, [PNG]);

    const markdown = await editorMarkdown(page);
    expect(markdown).not.toContain('![](');
    expect(markdown).toContain('some text');
  });

  /*
   * `defaultPrevented` cannot answer this one: ProseMirror prevents the default
   * on every drop it handles itself, so a claimed file drop and an ordinary
   * text drop look identical from outside. What separates them is whether the
   * editor still got to DO something with it — a drop carrying no files must
   * reach ProseMirror's own handling, which is what the internal block drag
   * rides on.
   */
  test('a drop carrying no files is left to the editor, so block drags still work', async ({
    page,
  }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'some text');

    await dropOnto(page, [], 'dragged words');

    expect(await editorMarkdown(page)).toContain('dragged words');
  });
});
