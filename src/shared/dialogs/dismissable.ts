/**
 * Escape-to-dismiss, owned once for every overlay in the app.
 *
 * Before this existed each dialog wired its own key handler — so a dialog that
 * simply forgot (FolderPickerModal) had no Escape at all, and one that attached
 * the handler to an element it never focused (CrashReportDialog) had an Escape
 * that never fired. Both are the same bug: dismissal was a per-dialog decision
 * instead of part of dialog composition.
 *
 * Use `Modal.svelte` for a standard modal (it applies this action for you), or
 * apply `use:dismissable` directly on an overlay with bespoke chrome.
 *
 * The contract:
 * - Escape dismisses the TOP-MOST registered overlay only — never two at once.
 * - It works wherever focus is, including inside a text field in the overlay,
 *   because the listener sits on `document` in the capture phase.
 * - Propagation stops at the listener, so the editor, slash menu, or a screen
 *   behind the overlay never also sees that Escape.
 * - The listener exists only while something is registered, and unregistering
 *   happens on unmount, so nothing leaks.
 */

interface Registration {
  ondismiss: () => void;
}

const stack: Registration[] = [];

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.ondismiss();
}

function register(registration: Registration): void {
  if (stack.length === 0) {
    document.addEventListener('keydown', handleKeydown, true);
  }
  stack.push(registration);
}

function unregister(registration: Registration): void {
  const index = stack.lastIndexOf(registration);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length === 0) {
    document.removeEventListener('keydown', handleKeydown, true);
  }
}

export interface DismissableOptions {
  /** Called when this overlay is the top-most one and Escape is pressed. */
  ondismiss: () => void;
  /** Set false to keep the overlay mounted but out of the Escape stack. */
  enabled?: boolean;
}

/**
 * Svelte action: while the node is mounted (and `enabled`), Escape dismisses it
 * if it is the top-most dismissable overlay.
 */
export function dismissable(_node: HTMLElement, options: DismissableOptions) {
  let current: Registration | null = null;

  function sync(next: DismissableOptions): void {
    if (next.enabled === false) {
      if (current) unregister(current);
      current = null;
      return;
    }
    if (current) {
      current.ondismiss = next.ondismiss;
      return;
    }
    current = { ondismiss: next.ondismiss };
    register(current);
  }

  sync(options);

  return {
    update(next: DismissableOptions) {
      sync(next);
    },
    destroy() {
      if (current) unregister(current);
      current = null;
    },
  };
}

/** Test-only: how many overlays are currently listening for Escape. */
export function _dismissableStackDepth(): number {
  return stack.length;
}
