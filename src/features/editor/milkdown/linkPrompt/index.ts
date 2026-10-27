/** The URL prompt shared by the slash menu and native formatting toolbar. */
import { shift } from '@floating-ui/dom';
import type { Editor } from '@milkdown/kit/core';
import { SlashProvider } from '@milkdown/kit/plugin/slash';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { mount, unmount } from 'svelte';

import { editorView } from '../caretContext';
import { applyLinkToSelection, linkRunAt } from './linkEditing';
import LinkUrlField from './LinkUrlField.svelte';

interface LinkUrlFieldHandle {
  focus: () => void;
}

/** Select the new URL so typing can replace its label immediately. */
function insertLinkAtCaret(view: ProseView, pos: number, href: string): void {
  const linkType = view.state.schema.marks.link;
  if (!linkType) return;
  const node = view.state.schema.text(href, [linkType.create({ href })]);
  const tr = view.state.tr.insert(pos, node);
  tr.setSelection(TextSelection.create(tr.doc, pos, pos + node.nodeSize));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// A prompt holds offsets from the note it opened on. Note switches and editor
// teardown must dismiss it before those offsets could reach another document.
let openPrompt: ((refocus?: boolean) => void) | null = null;

/** Dismiss without refocusing a note the user is leaving. */
export function dismissLinkPrompt(): void {
  openPrompt?.(false);
}

interface LinkFieldOptions {
  initialUrl: string;
  applyLabel: 'Add' | 'Update';
  onSubmit: (href: string) => void;
}

function openLinkFieldAt(view: ProseView, options: LinkFieldOptions): void {
  dismissLinkPrompt();

  const content = document.createElement('div');
  content.className = 'futo-selection-toolbar futo-link-prompt';
  const body = document.createElement('div');
  body.className = 'futo-selection-toolbar-body';
  content.appendChild(body);

  let settled = false;
  const provider = new SlashProvider({
    content,
    // Escape the editor scroller's clipping.
    root: document.body,
    floatingUIOptions: { strategy: 'fixed' },
    offset: 6,
    // Flip alone leaves the submit button off-screen on narrow phones.
    middleware: [shift({ padding: 8 })],
    debounce: 0,
    shouldShow: () => !settled,
  });

  // Capture before the editor can steal focus from the field.
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

  // Even debounce=0 mounts asynchronously; onShow guarantees an attached input.
  openPrompt = finish;
  provider.onShow = () => ui.focus();
  document.addEventListener('pointerdown', onPointerDown, true);
  provider.update(view);
}

export function openLinkPrompt(editor: Editor): void {
  const liveView = editorView(editor);
  if (!liveView) return;
  const view: ProseView = liveView;
  const { selection } = view.state;

  // A collapsed caret at a link's edge edits that link rather than adding one.
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
