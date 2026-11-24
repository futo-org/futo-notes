/* Re-opening the open note (an outside change adopted, DesktopEditor.svelte `reload`) empties
 * the page while the host reads the note back, which drops the pane's scroll to the top. */
import { scrollerOf } from './paneScroll';

/** Run `reopen`, then put the pane `editor` scrolls in back where it was, whether or not the
 *  re-open succeeded. */
export async function keepPaneScroll(
  editor: HTMLElement,
  reopen: () => Promise<void>,
): Promise<void> {
  const scroller = scrollerOf(editor);
  const scrollTop = scroller.scrollTop;
  try {
    await reopen();
  } finally {
    scroller.scrollTop = scrollTop;
  }
}
