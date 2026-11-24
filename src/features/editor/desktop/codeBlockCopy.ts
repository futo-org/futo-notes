/* A code block header's copy button (codeBlockHeader.ts): a block's code, its lines as written
 * without its fences, and the button's glyph turning to a check for a moment once it is on the
 * clipboard. */
import { codeBlockLinesAt } from './codeBlockSelection';
import type { EditorView } from './view';

const COPIED_FLASH_MILLISECONDS = 1100;

const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** The code of the block whose code starts at UTF-16 `at`: its lines joined by line breaks,
 *  empty for an empty block. */
export function codeBlockText(view: EditorView, at: number): string {
  const lines = view.displayLines();
  const block = codeBlockLinesAt(lines, view.lineAt(at));
  return lines
    .slice(block.first, block.last + 1)
    .map((line) => line.text)
    .join('\n');
}

/** Show the copied check on `button` for a moment; another copy restarts it. */
export function flashCopied(button: HTMLElement): void {
  clearTimeout(flashTimers.get(button));
  button.classList.add('copied');
  flashTimers.set(
    button,
    setTimeout(() => button.classList.remove('copied'), COPIED_FLASH_MILLISECONDS),
  );
}
