// The page fixture and caret/table helpers shared by the
// editor-embed-milkdown-interactive*.spec.ts suites, moved here verbatim from
// editor-embed-milkdown-interactive.spec.ts.

import type { Page } from '@playwright/test';
import { flushFrames, withCaretObserved, type FakeHostWindow } from './editorEmbedHost';
import { CHANGE_DEBOUNCE_MS, embedTest, hostConfig, initialize } from './editorEmbedSpec';

export const test = embedTest;

export async function open(page: Page, content: string): Promise<void> {
  await initialize(page, hostConfig({ content }));
}

/**
 * Click at the end of the first text run equal to `text`.
 *
 * The click goes through `withCaretObserved` because ProseMirror learns about
 * a pointer-placed caret from an ASYNC `selectionchange`, one rendering update
 * later — while Playwright's next call lands ~3 ms later. Without the wait the
 * Enter/Tab that follows is handled against the caret from BEFORE the click
 * (its doc comment has the whole story). `End` is deliberately outside the
 * wait: it can legitimately be a no-op, and it never leaves the cell the
 * table commands resolve.
 */
export async function caretAtEndOf(page: Page, text: string): Promise<void> {
  await withCaretObserved(page, () => page.getByText(text, { exact: true }).first().click());
  await page.keyboard.press('End');
}

export async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
}

/**
 * Click at the left edge of the first text run equal to `text` (see
 * `caretAtEndOf`). This places the caret at offset zero directly. Sending Home
 * afterward is a no-op on some hosts and produces no `selectionchange`, which
 * made the caret observer wait until timeout despite a correct selection.
 */
export async function caretAtStartOf(page: Page, text: string): Promise<void> {
  await withCaretObserved(page, () =>
    page
      .getByText(text, { exact: true })
      .first()
      .click({ position: { x: 0, y: 0 } }),
  );
  await page.waitForFunction((expectedText) => {
    const selection = document.getSelection();
    return (
      selection?.isCollapsed === true &&
      selection.anchorNode?.textContent === expectedText &&
      selection.anchorOffset === 0
    );
  }, text);
}

/** The serialized table as trimmed cell texts per row, delimiter row dropped. */
export function tableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
}

/** Open `markdown` as a different note, the way the host re-opens a saved one. */
export async function reopen(page: Page, markdown: string): Promise<void> {
  // Through another note first, so a same-bytes reopen is never deduped away.
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', '-'),
  );
  await page.evaluate(
    (m) => (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', m),
    markdown,
  );
  await flushFrames(page);
}

export const SMALL_TABLE = '| a | b |\n| - | - |\n| c | d |\n';

/** The visible text of the editor's top-level paragraphs, a `<br>` read as a newline. */
export function paragraphLines(page: Page): Promise<string[]> {
  return page
    .locator('.ProseMirror > p')
    .evaluateAll((paragraphs) =>
      paragraphs.map((paragraph) => (paragraph as HTMLElement).innerText.replace(/\n$/, '')),
    );
}

/** The visible last line of the last paragraph: what was typed after the last Enter. */
export async function lastLine(page: Page): Promise<string | undefined> {
  return (await paragraphLines(page)).at(-1)?.split('\n').at(-1);
}

/** Opens `text` with the caret at the end of the document. */
export async function openAtEnd(page: Page, text: string): Promise<void> {
  await open(page, text);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+End');
}

/**
 * Pastes `text` as plain text only — `text/plain` with no `text/html`, as from a
 * terminal or a code editor. Nothing in Playwright can put text on the OS
 * clipboard from a `file://` page, so the event is a dispatched `ClipboardEvent`
 * with a real `DataTransfer`; everything after it is ProseMirror's own paste.
 *
 * It first waits until ProseMirror's selection is the DOM's: a key like `End`
 * moves only the DOM caret, which ProseMirror reads from an async
 * `selectionchange`, so a paste dispatched straight after would land at the
 * caret from before the key (see `withCaretObserved`).
 */
export async function pastePlainText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(() => {
    const view = (
      window as unknown as {
        __futoProseMirrorView?: () => {
          dom: Element;
          state: { selection: { anchor: number; head: number } };
          posAtDOM: (node: Node, offset: number) => number;
        } | null;
      }
    ).__futoProseMirrorView?.();
    const dom = document.getSelection();
    if (!view || !dom?.anchorNode || !dom.focusNode || !view.dom.contains(dom.anchorNode)) {
      return true;
    }
    const { selection } = view.state;
    return (
      selection.anchor === view.posAtDOM(dom.anchorNode, dom.anchorOffset) &&
      selection.head === view.posAtDOM(dom.focusNode, dom.focusOffset)
    );
  });
  await page.evaluate((plain) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', plain);
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
  }, text);
  await flushFrames(page);
}
