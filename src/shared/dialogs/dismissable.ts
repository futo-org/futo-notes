/**
 * Dismissal, owned once for every overlay in the app: Escape for all of them,
 * plus acting outside for popovers that opt in with `outside`.
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
 * - The listeners exist only while something is registered, and unregistering
 *   happens on unmount, so nothing leaks.
 * - With `outside`, a pointer press or focus landing outside the node also
 *   dismisses, and `ondismiss` receives the reason. Apply it to the element
 *   holding BOTH trigger and popover so a press on the trigger counts as inside
 *   and only the trigger's click toggles.
 */

export type DismissReason = 'escape' | 'outside';

interface Registration {
  node: HTMLElement;
  outside: boolean;
  ondismiss: (reason: DismissReason) => void;
}

const stack: Registration[] = [];

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.ondismiss('escape');
}

function handleOutside(event: Event): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  for (const registration of [...stack]) {
    if (registration.outside && !registration.node.contains(target)) {
      registration.ondismiss('outside');
    }
  }
}

function register(registration: Registration): void {
  if (stack.length === 0) {
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('pointerdown', handleOutside, true);
    document.addEventListener('focusin', handleOutside, true);
  }
  stack.push(registration);
}

function unregister(registration: Registration): void {
  const index = stack.lastIndexOf(registration);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length === 0) {
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('pointerdown', handleOutside, true);
    document.removeEventListener('focusin', handleOutside, true);
  }
}

export interface DismissableOptions {
  ondismiss: (reason: DismissReason) => void;
  enabled?: boolean;
  outside?: boolean;
}

export function dismissable(node: HTMLElement, options: DismissableOptions) {
  let current: Registration | null = null;

  function sync(next: DismissableOptions): void {
    if (next.enabled === false) {
      if (current) unregister(current);
      current = null;
      return;
    }
    if (current) {
      current.ondismiss = next.ondismiss;
      current.outside = next.outside === true;
      return;
    }
    current = { node, outside: next.outside === true, ondismiss: next.ondismiss };
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

/** Test-only: how many overlays are currently registered for dismissal. */
export function _dismissableStackDepth(): number {
  return stack.length;
}
