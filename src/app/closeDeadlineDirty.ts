import { reportUnsavedEdits } from '$lib/platform/tauri';
import { setEditIntentListener } from '$shared/lifecycle/editIntent';

/**
 * Tells Rust whether the open note holds edits that are not on disk yet, so the
 * window-close deadline (apps/tauri/src-tauri/src/close_deadline.rs) never cuts
 * a page that is only slow, not wedged by a note open. A page with an unsaved
 * edit is waited for, not exited: the JS close handler is the thing that saves it.
 *
 * "Dirty" is a save that is pending or in flight, PLUS a short window after any
 * input. The window matters because the save counts as pending only once the
 * editor has applied the edit, and a stall that starts before then (a
 * multi-megabyte paste parsing synchronously) would otherwise be invisible: the
 * thread that would report the edit is the one that is blocked. Reporting on the
 * input event itself, before the work starts, closes that gap; once the thread is
 * blocked the last report simply stays in force.
 *
 * Edits that raise no input event at all (in the desktop editor, Undo, Tab and
 * Ctrl+K) are not reported at once: they make the save pending, and the next poll
 * (every 200 ms) reports that. The desktop editor raises no edit intent
 * (shared/lifecycle/editIntent.ts); only the notes-shell test hook does.
 *
 * Only edits count as input. A click or a keydown that edits nothing would leave
 * the page "dirty" until the next poll, and a click on a note in the sidebar
 * happens right before the giant open this whole mechanism exists to get out of.
 */

/** Longer than the poll, so the pending save has taken over by the time it lapses. */
const EDIT_SETTLE_MS = 600;
const POLL_MS = 200;
const EDIT_EVENTS = ['beforeinput', 'paste', 'cut', 'drop'] as const;

export interface CloseDirtyReporterDeps {
  isSavePending: () => boolean;
  /** Defaults to the Rust command. */
  report?: (dirty: boolean) => void;
  now?: () => number;
}

export function startCloseDirtyReporter(deps: CloseDirtyReporterDeps): () => void {
  const report =
    deps.report ??
    ((dirty: boolean) => {
      void reportUnsavedEdits(dirty).catch(() => {});
    });
  const now = deps.now ?? Date.now;
  let reported = false;
  let lastEditAt = Number.NEGATIVE_INFINITY;

  const evaluate = (): void => {
    const dirty = deps.isSavePending() || now() - lastEditAt < EDIT_SETTLE_MS;
    if (dirty === reported) return;
    reported = dirty;
    report(dirty);
  };
  const onEdit = (): void => {
    lastEditAt = now();
    evaluate();
  };

  for (const type of EDIT_EVENTS) document.addEventListener(type, onEdit, true);
  const timer = window.setInterval(evaluate, POLL_MS);
  setEditIntentListener(onEdit);
  return () => {
    for (const type of EDIT_EVENTS) document.removeEventListener(type, onEdit, true);
    window.clearInterval(timer);
    setEditIntentListener(null);
    if (reported) report(false);
  };
}
