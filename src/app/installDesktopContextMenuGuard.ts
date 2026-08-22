import { isDesktop } from '$lib/platform';

// Right-clicking a webview's chrome opens WebKit's own menu — "Reload",
// "Services", "Inspect Element". Nothing ends the illusion of a native app
// faster, and none of those commands mean anything here.
//
// What must survive is the native TEXT menu: inside a note or a text field,
// Cut/Copy/Paste, Look Up, Share and the spellchecker's suggestions come from
// the OS and a notes app that lost them has traded a cosmetic problem for a
// functional one. So the guard suppresses the menu only where it is furniture:
// no editable target, and no live selection to act on.
//
// Desktop only. The native iOS/Android shells host the editor directly and
// never load this module; the browser dev server keeps its normal menu.
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], .cm-editor';

export function shouldSuppressContextMenu(
  target: EventTarget | null,
  selection: Selection | null,
): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(EDITABLE_SELECTOR)) return false;
  if (selection && !selection.isCollapsed && selection.toString().trim() !== '') return false;
  return true;
}

export function installDesktopContextMenuGuard(): () => void {
  if (!isDesktop) return () => {};

  function handleContextMenu(event: MouseEvent): void {
    // An app-owned menu (note/folder rows) already claimed this click.
    if (event.defaultPrevented) return;
    if (shouldSuppressContextMenu(event.target, window.getSelection())) {
      event.preventDefault();
    }
  }

  window.addEventListener('contextmenu', handleContextMenu);
  return () => window.removeEventListener('contextmenu', handleContextMenu);
}
