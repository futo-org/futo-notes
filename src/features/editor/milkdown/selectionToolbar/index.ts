/*
 * The desktop selection toolbar — Milkdown's tooltip plugin, wired to this
 * editor.
 *
 * `tooltipFactory` (@milkdown/kit/plugin/tooltip) is the mount point, exactly
 * as `slashFactory` is for the `/` menu: a ctx slice holding a ProseMirror
 * `PluginSpec` and a `$prose` that instantiates it. `TooltipProvider` shows,
 * hides and POSITIONS the element with floating-ui above the selection — the
 * one positioning system this editor already runs the ⠿ handle and the `/`
 * menu through.
 *
 * WHAT it offers is `SelectionToolbar.svelte`; WHEN it shows is `target.ts`.
 * The four format buttons run the shared `createToolbarExec` commands (M10:
 * one implementation per command, the same one the native toolbars dispatch),
 * and Link is the one command with a UI of its own — the URL field — because
 * the desktop otherwise has nowhere to type a link's address.
 *
 * Desktop only, via `resolveSelectionToolbar` — see its comment for why. This
 * replaces the CodeMirror editor's floating selection toolbar, deleted with
 * that engine (docs/plan/desktop-editor-parity.md D1, docs/spec/editor.md
 * "Interactive elements"). Covered by `tests/selection-toolbar.spec.ts`.
 */
import type { Editor } from '@milkdown/kit/core';
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';
import { tooltipFactory, TooltipProvider } from '@milkdown/kit/plugin/tooltip';
import { toggleLinkCommand } from '@milkdown/kit/preset/commonmark';
import type { PluginSpec } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { callCommand } from '@milkdown/kit/utils';
import { mount, unmount } from 'svelte';

import { editorView } from '../caretContext';
import { computeActiveFormats } from '../formatState';
import { createToolbarExec } from '../toolbarExec';
import SelectionToolbar from './SelectionToolbar.svelte';
import { linkRunAt, selectionToolbarTarget, type SelectionToolbarTarget } from './target';

export { resolveSelectionToolbar } from './target';

/** Class on the floating element; styled in MilkdownEditor.svelte. */
export const SELECTION_TOOLBAR_CLASS = 'futo-selection-toolbar';

export interface SelectionToolbarPlugin {
  /** Runs inside the editor's `.config()`; installs the plugin spec. */
  config: (ctx: Ctx) => void;
  /** Passed to the editor's `.use()`. */
  plugins: MilkdownPlugin[];
}

/**
 * `documentToken` is WHICH note the editor is holding, as any value that
 * changes when it adopts a different one (MilkdownEditor.svelte's
 * `documentGeneration`). The URL field is the one part of this bar that
 * outlives a single gesture: it stays open while the user types, and a
 * keyboard note switch moves no DOM focus and fires no pointerdown, so
 * neither dismissal path ran — submitting then applied the link to the caret
 * in a note the user never opened the field on. Same rule as
 * `imageInsertTarget.ts`, stated for a UI surface instead of a completion.
 */
export function createSelectionToolbarPlugin(
  getEditor: () => Editor | null,
  documentToken: () => unknown,
): SelectionToolbarPlugin {
  const tooltip = tooltipFactory('futoSelectionToolbar');
  const exec = createToolbarExec(getEditor);

  return {
    plugins: tooltip,
    config: (ctx: Ctx) => {
      const spec: PluginSpec<unknown> = {
        view: (view) => {
          /* Owned by this closure rather than by ProseMirror plugin state: the
           * target is recomputed from the document on every update, so the only
           * thing that has to survive a transaction is whether the URL field is
           * open — and that is the component's own. */
          let target: SelectionToolbarTarget | null = null;
          let editingLink = false;
          /** The note the open URL field belongs to; null when none is open. */
          let editingOn: unknown = null;

          const content = document.createElement('div');
          content.className = SELECTION_TOOLBAR_CLASS;

          /**
           * Apply a link edit to the selection the toolbar was opened for.
           *
           * The URL field held the DOM focus, but ProseMirror's own selection is
           * untouched by that, so the commands still see the range. An EXISTING
           * link is edited over its whole run (`linkRunAt`) and the selection is
           * left alone, so the bar stays up for the next edit — an unlink right
           * after a URL change, say. A `null` href with no link is "nothing
           * typed, leave it" (the field's Escape) and changes nothing.
           */
          const applyLink = (href: string | null): void => {
            const editor = getEditor();
            const live = editorView(editor);
            if (!editor || !live || !target) return;
            const { state } = live;
            const run = linkRunAt(state.doc, state.selection.head);
            if (run) {
              const linkType = run.mark.type;
              if (href === null || href === '') {
                live.dispatch(state.tr.removeMark(run.from, run.to, linkType));
              } else if (href !== run.mark.attrs.href) {
                live.dispatch(
                  state.tr
                    .removeMark(run.from, run.to, linkType)
                    .addMark(run.from, run.to, linkType.create({ ...run.mark.attrs, href })),
                );
              }
            } else if (href !== null && href !== '') {
              editor.action(callCommand(toggleLinkCommand.key, { href }));
            }
            live.focus();
          };

          const ui = mount(SelectionToolbar, {
            target: content,
            props: {
              onexec: (command: string) => exec[command]?.(),
              onlink: applyLink,
              onlinkediting: (editing: boolean) => {
                editingLink = editing;
                editingOn = editing ? documentToken() : null;
              },
            },
          });

          const provider = new TooltipProvider({
            content,
            // Positioned against `body` in viewport coordinates, so the bar
            // cannot be clipped by the shell's scroller or by
            // `.editor-container`'s `overflow-x: clip` — same as the `/` menu.
            root: document.body,
            floatingUIOptions: { strategy: 'fixed', placement: 'top' },
            offset: 8,
            // #015: floating-ui's `shift` middleware defaults its collision
            // boundary to the viewport, so with nothing else telling it where
            // the editor's own column ends, it happily shifted the bar over the
            // sidebar (and the sidebar's create-note/new-folder buttons) when a
            // selection sat near the editor's left edge. Bound `shift` to the
            // editable DOM instead — it spans exactly the editor's own column,
            // which starts right where the sidebar ends — so the bar can never
            // be placed over the sidebar at any window width.
            shift: { boundary: view.dom, padding: 8 },
            debounce: 0,
            /* Shown for a formattable selection while the editor — or the
             * toolbar's own URL field — has focus. `view.composing` covers an
             * IME mid-composition, where a bar over the text would sit on top
             * of the candidate window. */
            shouldShow: (live) =>
              target !== null &&
              live.editable &&
              !live.composing &&
              (live.hasFocus() || content.contains(document.activeElement)),
          });
          provider.onHide = () => {
            ui.reset();
          };

          const refresh = (live: ProseView, prevState?: ProseView['state']): void => {
            // The note changed under an open URL field: close it rather than
            // let a submit apply the link to this note. `reset` reports the
            // close back through `onlinkediting`, which clears the pin below.
            if (editingLink && editingOn !== documentToken()) ui.reset();
            target = editingLink ? target : selectionToolbarTarget(live.state);
            if (target) {
              const { selection, storedMarks, schema } = live.state;
              const active = computeActiveFormats(live, selection, storedMarks);
              const inlineCode = schema.marks.inlineCode;
              if (inlineCode && live.state.doc.rangeHasMark(target.from, target.to, inlineCode)) {
                active.push('code');
              }
              ui.setState(active, target.linkHref);
            }
            provider.update(live, prevState);
          };

          /* Focus moves are not transactions, so the provider would never hear
           * about them on its own: a click into the sidebar would leave the bar
           * floating over a note that no longer has focus. Losing focus hides
           * unless it went INTO the toolbar (its URL field); regaining it
           * re-evaluates. `focusout` carries the element the focus is going TO,
           * so this is decided synchronously — a deferred `activeElement` check
           * was measured racing the field's own focus and hiding the bar. */
          const onFocusOut = (event: FocusEvent): void => {
            const next = event.relatedTarget;
            if (!(next instanceof Node) || !content.contains(next)) provider.hide();
          };
          const onFocus = (): void => refresh(view);
          view.dom.addEventListener('focusout', onFocusOut);
          view.dom.addEventListener('focus', onFocus);

          return {
            update: (live, prevState) => refresh(live, prevState),
            destroy: () => {
              view.dom.removeEventListener('focusout', onFocusOut);
              view.dom.removeEventListener('focus', onFocus);
              provider.destroy();
              void unmount(ui);
              content.remove();
            },
          };
        },
      };

      ctx.set(tooltip.key, spec);
    },
  };
}
