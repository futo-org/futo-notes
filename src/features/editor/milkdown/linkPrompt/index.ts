/*
 * The shared Link URL prompt — QA-019 ("add Link to the `/` menu").
 *
 * `LinkUrlField.svelte` is the desktop selection toolbar's own URL field
 * (added in d70bf007), extracted so the `/` menu's Link item opens the exact
 * same prompt rather than a second one. This module supplies the other half
 * the toolbar already had built in: WHERE the field floats when there is no
 * selection-toolbar target to hand it to, and WHAT submitting or cancelling
 * it does for a plain caret.
 *
 * POSITIONING reuses `SlashProvider` (@milkdown/kit/plugin/slash) — the same
 * floating-ui `computePosition` + `flip` the `/` menu itself and the
 * selection toolbar already run through, so this is not a second positioning
 * system. It is called with the CURRENT (collapsed) selection already in
 * place and never again: nothing about the document changes while this
 * prompt is open (the user is typing into the prompt's own `<input>`, not the
 * editor), so one position computed up front is all there ever is to do.
 *
 * THE ONE CASE: the `/` menu's Link item only ever fires on a collapsed
 * caret — `slash/exec.ts` deletes the typed `/link` run before opening this
 * — so there is never an existing selection, and never an existing link
 * mark to edit. Submitting always INSERTS new text, using the URL itself as
 * its visible label (the same fallback most link-insert UIs use when there
 * is nothing selected to label the link with), and leaves that text
 * SELECTED so the user can type a real label straight over it. An empty URL,
 * Escape, or a click/tap outside the prompt all cancel and leave the
 * document exactly as the delete above left it — the typed `/link` run gone,
 * nothing inserted in its place.
 */
import type { Editor } from '@milkdown/kit/core';
import { SlashProvider } from '@milkdown/kit/plugin/slash';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { mount, unmount } from 'svelte';

import { editorView } from '../caretContext';
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
 * Opens the Link URL prompt at the editor's current (collapsed) caret. See
 * this module's header comment for what submitting or cancelling it does.
 */
export function openLinkPrompt(editor: Editor): void {
  const liveView = editorView(editor);
  if (!liveView) return;
  // Rebound so its non-null type survives inside the closures below — a
  // nested function declaration does not inherit the `if (!liveView) return`
  // narrowing above, even though `liveView` itself is never reassigned.
  const view: ProseView = liveView;

  const pos = view.state.selection.from;

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

  function finish(): void {
    if (settled) return;
    settled = true;
    document.removeEventListener('pointerdown', onPointerDown, true);
    provider.destroy();
    void unmount(ui);
    content.remove();
    view.focus();
  }

  const ui = mount(LinkUrlField, {
    target: body,
    props: {
      initialUrl: '',
      applyLabel: 'Add',
      onsubmit: (href: string) => {
        finish();
        if (href) insertLinkAtCaret(view, pos, href);
      },
      oncancel: finish,
    },
  }) as unknown as LinkUrlFieldHandle;

  // `SlashProvider`'s own debounce (0ms is still asynchronous — a lodash
  // `debounce`, not a synchronous call) means the element is not yet
  // appended to `document.body` right after `provider.update(view)` returns;
  // a plain `requestAnimationFrame` raced that and called `.focus()` on a
  // still-detached input, which is a silent no-op. `onShow` fires exactly
  // once the element IS attached (`SlashProvider`'s `#onUpdate` appends it
  // before calling `.show()`), so focusing there is never early.
  provider.onShow = () => ui.focus();
  document.addEventListener('pointerdown', onPointerDown, true);
  provider.update(view);
}
