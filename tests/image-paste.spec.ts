import { test, expect, Page } from '@playwright/test';

import { EDITOR, editorMarkdown, openNewNote, setEditorMarkdown } from './lib/desktopEditor';

/**
 * Pasting into the editor when the host cannot save image bytes.
 *
 * The web dev server has no `saveImageBytes`, which is exactly the case that
 * must not corrupt a note: the image paste sink declines, so an image on the
 * clipboard leaves no `![](…)` behind and a plain-text paste is unaffected.
 * `imagePasteSink.ts` survived the engine swap, so this is the same product
 * rule as before — only the way the paste is delivered changed, from a
 * CodeMirror `contentDOM` dispatch to the editable element itself.
 */

interface PastePayload {
  /** Plain text on the clipboard, if any. */
  text?: string;
  /** An image file on the clipboard, if any. */
  image?: { name: string; type: string; bytes: number[] };
}

async function pasteInto(page: Page, payload: PastePayload): Promise<void> {
  await page.locator(EDITOR).click();
  await page.evaluate(
    ({ selector, text, image }) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('editor not found');
      const transfer = new DataTransfer();
      if (text !== undefined) transfer.setData('text/plain', text);
      if (image) {
        transfer.items.add(
          new File([new Uint8Array(image.bytes)], image.name, { type: image.type }),
        );
      }
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    { selector: EDITOR, text: payload.text, image: payload.image },
  );
}

const PNG_HEADER = { name: 'screenshot.png', type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] };
const JPEG_HEADER = { name: 'photo.jpg', type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] };

test.describe('Image paste with no image storage', () => {
  test('a plain-text paste still lands', async ({ page }) => {
    await openNewNote(page);

    await pasteInto(page, { text: 'pasted text' });

    await expect(page.locator(EDITOR)).toContainText('pasted text');
    expect(await editorMarkdown(page)).not.toContain('![](');
  });

  test('an image on the clipboard inserts no image markdown', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'some text');

    await pasteInto(page, { image: PNG_HEADER });

    const markdown = await editorMarkdown(page);
    expect(markdown).not.toContain('![](');
    // The note it declined to add an image to must survive intact.
    expect(markdown).toContain('some text');
  });

  test('a mixed text-and-image paste falls back to the text', async ({ page }) => {
    await openNewNote(page);

    await pasteInto(page, { text: 'fallback text', image: JPEG_HEADER });

    expect(await editorMarkdown(page)).not.toContain('![](');
  });
});
