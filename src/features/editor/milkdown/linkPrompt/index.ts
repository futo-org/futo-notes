/*
 * The shared Link URL prompt — QA-019 ("add Link to the `/` menu") and
 * QA-005 ("how should Link be used on Android?" — the mobile/embed toolbar's
 * Link button).
 *
 * `LinkUrlField.svelte` is the desktop selection toolbar's own URL field
 * (added in d70bf007), extracted so every caller that needs a Link URL prompt
 * opens the exact same one rather than a fork each. This module supplies the
 * other half the toolbar already had built in: WHERE the field floats when
 * there is no selection-toolbar target to hand it to, and WHAT submitting or
 * cancelling it does.
 *
 * POSITIONING reuses `SlashProvider` (@milkdown/kit/plugin/slash) — the same
 * floating-ui `computePosition` + `flip` the `/` menu itself and the
 * selection toolbar already run through, so this is not a second positioning
 * system. It is called with the CURRENT selection already in place and never
 * again: nothing about the document changes while this prompt is open (the
 * user is typing into the prompt's own `<input>`, not the editor), so one
 * position computed up front is all there ever is to do.
 *
 * THREE CASES, one entry point (`openLinkPrompt`), checked in this order:
 *
 *   - The selection HEAD sits inside an existing link's run — whether or not
 *     the selection is empty. A bare CARET glued to a link is reachable on
 *     mobile in a way it never is from the `/` menu or the desktop selection
 *     toolbar: a selection-handle drag that resolves back to a collapsed
 *     caret at the link's edge (measured on Android — the toolbar's Link
 *     button is already lit from `formatState` at exactly that position).
 *     The WHOLE run is prefilled and updated in place (never split at the
 *     selection's edges, mirroring `selectionToolbar/index.ts` `applyLink`),
 *     and emptying the field unlinks it.
 *   - A collapsed CARET with no adjacent link — the only case the `/` menu's
 *     Link item can reach (`slash/exec.ts` deletes the typed `/link` run
 *     first, so there is never a selection or an existing link mark) and the
 *     mobile toolbar's ordinary case too. Submitting INSERTS new text, using
 *     the URL itself as its visible label (the same fallback most link-insert
 *     UIs use when there is nothing selected to label the link with), and
 *     leaves that text SELECTED so a real label can be typed straight over it.
 *   - A non-empty SELECTION with no existing link — only the mobile
 *     toolbar's Link button reaches this (the desktop selection toolbar has
 *     its own inline field for it). Submitting wraps the selection in a new
 *     link.
 *
 * Every case: an empty URL on a plain caret with no existing link, Escape, or
 * a click/tap outside the prompt all cancel and leave the document untouched
 * (the `/` menu case leaves it exactly as its own `/link` deletion left it).
 */
import type { Editor } from '@milkdown/kit/core';
import { SlashProvider } from '@milkdown/kit/plugin/slash';
import { callCommand } from '@milkdown/kit/utils';
import { toggleLinkCommand } from '@milkdown/kit/preset/commonmark';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { mount, unmount } from 'svelte';

import { editorView } from '../caretContext';
import { linkRunAt, type LinkRun } from '../selectionToolbar/target';
import LinkUrlField from './LinkUrlField.svelte';

interface LinkUrlFieldHandle {
  focus: () => void;
}

/**
 * Inserts `href` as a new run of text at `pos`, using the URL as its own
 * label, and selects the inserted text end to end.
 */
function insertLinkAtCaret(view: ProseView, pos: number, href: string): void {
  const linkType = view.state.schema.marks.link;
  if (!linkType) return;
  const node = view.state.schema.text(href, [linkType.create({ href })]);
  const tr = view.state.tr.insert(pos, node);
  tr.setSelection(TextSelection.create(tr.doc, pos, pos + node.nodeSize));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/**
 * Applies `href` to `run` — the link the SELECTION was already sitting in —
 * or, when there is no such run, wraps the current selection in a fresh link.
 * The same editing rule as the desktop selection toolbar's `applyLink`
 * (`selectionToolbar/index.ts`), so a selection edited from either surface
 * behaves identically (root AGENTS.md M10): an existing link is edited over
 * its WHOLE run, never split at the selection's edges, and an empty href
 * unlinks it; with no existing link, an empty href is a no-op.
 */
function applyLinkToSelection(
  editor: Editor,
  view: ProseView,
  run: LinkRun | null,
  href: string,
): void {
  if (run) {
    const linkType = run.mark.type;
    if (href === '') {
      view.dispatch(view.state.tr.removeMark(run.from, run.to, linkType));
    } else if (href !== run.mark.attrs.href) {
      view.dispatch(
        view.state.tr
          .removeMark(run.from, run.to, linkType)
          .addMark(run.from, run.to, linkType.create({ ...run.mark.attrs, href })),
      );
    }
  } else if (href !== '') {
    editor.action(callCommand(toggleLinkCommand.key, { href }));
  }
  view.focus();
}

/*
 * The prompt currently on screen, so a NOTE SWITCH can take it down.
 *
 * It is the link sibling of the delayed-image bug (`imageInsertTarget.ts`):
 * the prompt floats over the editor holding `pos`/`run` from the note it
 * opened on, and the editor is reused across notes. A keyboard note switch
 * moves no DOM focus and fires no pointerdown, so neither dismissal path ran
 * — Ctrl+Tab with the field open, then Enter, dispatched `tr.insert(pos, …)`
 * or a `removeMark`/`addMark` over the OLD note's offsets against the NEW
 * note's document: a link in a note nobody asked for, marks rewritten over an
 * unrelated range, or a ProseMirror `RangeError` when the new note is shorter.
 *
 * There is at most one: `openLinkFieldAt` is only reached from a user gesture
 * that already dismissed any previous prompt.
 */
let openPrompt: ((refocus?: boolean) => void) | null = null;

/**
 * Cancels the prompt if one is open, leaving the document untouched. Called
 * when the editor adopts a different note or is torn down; without the
 * refocus, which would pull the caret into a note the user is leaving.
 */
export function dismissLinkPrompt(): void {
  openPrompt?.(false);
}

interface LinkFieldOptions {
  initialUrl: string;
  applyLabel: 'Add' | 'Update';
  onSubmit: (href: string) => void;
}

/**
 * Floats `LinkUrlField` at the view's current selection and wires submit/
 * cancel. Shared by both cases `openLinkPrompt` handles below — only what a
 * submit DOES differs between them.
 */
function openLinkFieldAt(view: ProseView, options: LinkFieldOptions): void {
  // At most one on screen: a second gesture replaces the first rather than
  // leaving it mounted with nothing tracking it.
  dismissLinkPrompt();

  const content = document.createElement('div');
  content.className = 'futo-selection-toolbar';
  const body = document.createElement('div');
  body.className = 'futo-selection-toolbar-body';
  content.appendChild(body);

  let settled = false;
  const provider = new SlashProvider({
    content,
    // Body-mounted and viewport-positioned, same as the `/` menu and the
    // selection toolbar: not clipped by the shell's scroller or by
    // `.editor-container`'s `overflow-x: clip`.
    root: document.body,
    floatingUIOptions: { strategy: 'fixed' },
    offset: 6,
    debounce: 0,
    shouldShow: () => !settled,
  });

  // A tap/click outside the prompt (including back into the editor) cancels
  // it — `pointerdown`, capturing, so it runs before the editor would
  // otherwise steal focus back (the same reasoning as the wikilink
  // suggestion popup's own outside-dismiss).
  const onPointerDown = (event: PointerEvent): void => {
    if (!content.contains(event.target as Node)) finish();
  };

  function finish(refocus = true): void {
    if (settled) return;
    settled = true;
    if (openPrompt === finish) openPrompt = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    provider.destroy();
    void unmount(ui);
    content.remove();
    if (refocus) view.focus();
  }

  const ui = mount(LinkUrlField, {
    target: body,
    props: {
      initialUrl: options.initialUrl,
      applyLabel: options.applyLabel,
      onsubmit: (href: string) => {
        finish();
        options.onSubmit(href);
      },
      oncancel: () => finish(),
    },
  }) as unknown as LinkUrlFieldHandle;

  // `SlashProvider`'s own debounce (0ms is still asynchronous — a lodash
  // `debounce`, not a synchronous call) means the element is not yet
  // appended to `document.body` right after `provider.update(view)` returns;
  // a plain `requestAnimationFrame` raced that and called `.focus()` on a
  // still-detached input, which is a silent no-op. `onShow` fires exactly
  // once the element IS attached (`SlashProvider`'s `#onUpdate` appends it
  // before calling `.show()`), so focusing there is never early.
  openPrompt = finish;
  provider.onShow = () => ui.focus();
  document.addEventListener('pointerdown', onPointerDown, true);
  provider.update(view);
}

/**
 * Opens the Link URL prompt for the editor's current selection — a plain
 * caret, or a range. See this module's header comment for what submitting or
 * cancelling it does in each case.
 */
export function openLinkPrompt(editor: Editor): void {
  const liveView = editorView(editor);
  if (!liveView) return;
  // Rebound so its non-null type survives inside the closures below — a
  // nested function declaration does not inherit the `if (!liveView) return`
  // narrowing above, even though `liveView` itself is never reassigned.
  const view: ProseView = liveView;
  const { selection } = view.state;

  // Checked BEFORE branching on empty/non-empty: a bare caret can sit right
  // inside — or glued to the edge of — an existing link with no selection at
  // all (measured on Android: a drag-handle move that lands the caret at the
  // end of a link, with the toolbar's Link button already lit from
  // `formatState`). The `/` menu never hits this (its caret is always a
  // freshly-deleted `/link` run, never adjacent to a real link), but the
  // mobile toolbar's Link button is reachable from exactly this state, and
  // without this check it would insert a SECOND, unrelated link glued to the
  // first rather than editing the one the user is looking at.
  const run = linkRunAt(view.state.doc, selection.head);
  if (run) {
    const initialUrl = typeof run.mark.attrs.href === 'string' ? run.mark.attrs.href : '';
    openLinkFieldAt(view, {
      initialUrl,
      applyLabel: 'Update',
      onSubmit: (href) => applyLinkToSelection(editor, view, run, href),
    });
    return;
  }

  if (selection.empty) {
    const pos = selection.from;
    openLinkFieldAt(view, {
      initialUrl: '',
      applyLabel: 'Add',
      onSubmit: (href) => {
        if (href) insertLinkAtCaret(view, pos, href);
      },
    });
    return;
  }

  openLinkFieldAt(view, {
    initialUrl: '',
    applyLabel: 'Add',
    onSubmit: (href) => applyLinkToSelection(editor, view, null, href),
  });
}
