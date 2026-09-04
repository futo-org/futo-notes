/*
 * The `/` block menu — Milkdown's own slash plugin, wired to this editor.
 *
 * `slashFactory` (@milkdown/kit/plugin/slash) is the mount point: it makes a
 * ctx slice holding a ProseMirror `PluginSpec` and a `$prose` that instantiates
 * it, so the menu's keyboard handling and its view are one ordinary ProseMirror
 * plugin. `SlashProvider` is the other half — it shows, hides and POSITIONS the
 * element with floating-ui, the same `computePosition` + `flip` that
 * @milkdown/plugin-block already runs the ⠿ handle through, so this editor has
 * one positioning system rather than two.
 *
 * The provider's own defaults are not usable for a FILTERABLE menu, and are
 * replaced: its `shouldShow` matches only while the last typed character is the
 * trigger, so the menu would vanish the moment a query was typed, and its
 * 200 ms debounce would leave it a fifth of a second behind the keyboard.
 *
 * WHAT the menu offers is `items.ts`; what picking one DOES is `exec.ts`.
 * Desktop only, via `resolveSlashMenu` — see its comment for why.
 *
 * This replaces the CodeMirror editor's block-command menu, deleted with that
 * engine (docs/plan/desktop-editor-parity.md D2, docs/spec/editor.md
 * "Interactive elements"). Covered by `tests/slash-menu.spec.ts`.
 */
import type { Editor } from '@milkdown/kit/core';
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';
import { slashFactory, SlashProvider } from '@milkdown/kit/plugin/slash';
import { TextSelection, type PluginSpec } from '@milkdown/kit/prose/state';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { blockFormatAtPos } from '../blockCommands';
import { editorView } from '../caretContext';
import { createSlashExec } from './exec';
import { filterSlashItems, type SlashItem } from './items';
import { SlashMenu } from './menu';

/**
 * Whether this editor instance mounts the `/` menu.
 *
 * Desktop only. The native shells have a real formatting toolbar docked over
 * the keyboard (packages/editor/src/toolbar.ts) — that IS their block-format
 * surface — and a phone keyboard has neither the arrow keys nor the Escape the
 * menu is driven with, so on a phone `/` should stay what it is: a character.
 *
 * Named here rather than read inline because `src/AGENTS.md` says components
 * never branch on platform — the same reason `blockDragMode.ts` and
 * `blockContainment.ts` exist, off the same `nativeShell` prop.
 */
export function resolveSlashMenu(nativeShell: boolean): 'enabled' | 'disabled' {
  return nativeShell ? 'disabled' : 'enabled';
}

/**
 * The `/` and its query, when the caret sits in one.
 *
 * The `/` must be the FIRST non-space character of its block — the CodeMirror
 * menu's rule too — so `and/or`, a URL and a fraction all stay text. The query
 * runs to the caret and holds no whitespace, so typing a space after `/` is how
 * you say you meant the character.
 *
 * That rule also pins the menu's anchor to the note's left margin, which is why
 * `SlashProvider`'s vertical-only `flip()` is placement enough: the menu can
 * never open hard against the right edge of the window. Loosening the trigger
 * means revisiting that.
 */
const SLASH_RUN = /^\s*\/(\S*)$/;

interface OpenRun {
  /** Document position of the `/`. */
  from: number;
  items: SlashItem[];
}

/**
 * The open `/` run at the caret, or null when there is none.
 *
 * A run with NO matching items still comes back, so an Escape can be remembered
 * across a query that matches nothing; the caller keeps the menu hidden on an
 * empty item list either way.
 */
function readOpenRun(state: EditorState): OpenRun | null {
  const { selection } = state;
  if (!selection.empty || !(selection instanceof TextSelection)) return null;

  const $head = selection.$head;
  // A code block's content is literal text (blockCommands.ts), so a `/` there is
  // code — and no item could act on it anyway.
  if (blockFormatAtPos($head).kind === 'code') return null;

  /* Cheap reject before the string build. This runs on every transaction, i.e.
   * every keystroke (AGENTS.md M5), and `textBetween` allocates; a block with no
   * `/` in it cannot hold an open run. */
  if (!$head.parent.textContent.includes('/')) return null;

  const textBefore = $head.parent.textBetween(
    0,
    $head.parentOffset,
    undefined,
    // A leaf (a wikilink chip, an image) must occupy one character so the offset
    // arithmetic below still lands on the right document position.
    '￼',
  );
  const found = SLASH_RUN.exec(textBefore);
  if (!found) return null;

  const query = found[1];
  return { from: $head.pos - (query.length + 1), items: filterSlashItems(query) };
}

export interface SlashMenuPlugin {
  /** Runs inside the editor's `.config()`; installs the plugin spec. */
  config: (ctx: Ctx) => void;
  /** Passed to the editor's `.use()`. */
  plugins: MilkdownPlugin[];
}

export function createSlashMenuPlugin(getEditor: () => Editor | null): SlashMenuPlugin {
  const slash = slashFactory('futoBlockMenu');
  const exec = createSlashExec(getEditor);

  /* Owned by this closure rather than by ProseMirror plugin state: the run
   * itself is recomputed from the document on every update, so the only things
   * that have to survive a transaction are the highlighted row and a dismissal
   * — neither a document position that would need mapping. */
  let open: OpenRun | null = null;
  let selected = 0;
  /** The `/` run Escape closed, so it does not reopen on the next keystroke. */
  let dismissedFrom: number | null = null;

  /**
   * Run the picked command, THEN delete the `/query` the user typed to get here.
   *
   * That order is load-bearing, and the obvious one is wrong. Deleting first
   * leaves the block momentarily EMPTY; ProseMirror re-renders an empty
   * textblock with a trailing `<br>`, its DOM observer reads that mutation back
   * as a document change, and the resulting transaction lands after the command
   * and drags the caret out of the block that was just made. Measured on
   * `/task`: a correct `- [ ] ` item with the next typed word in the paragraph
   * AFTER the list — every time by mouse, one run in five by keyboard. Running
   * the command first means the block is never empty with work still pending,
   * and the delete has the last word on where the caret sits: 10 runs out of 10
   * on both paths.
   *
   * The typed run is re-read rather than remembered because the command moves
   * it — wrapping a paragraph in a list shifts every position after it.
   *
   * Both dispatches are synchronous and adjacent, so prosemirror-history keeps
   * them in one undo event: one Ctrl-Z takes back the whole pick rather than
   * leaving a heading with `/heading` typed back into it.
   */
  function commit(view: ProseView, item: SlashItem): void {
    open = null;
    dismissedFrom = null;
    exec[item.id]?.();
    const typed = readOpenRun(view.state);
    if (typed) view.dispatch(view.state.tr.delete(typed.from, view.state.selection.head));
  }

  /** Re-render on a state change that is not a document change (arrow, Escape). */
  function refresh(view: ProseView): void {
    view.dispatch(view.state.tr);
  }

  return {
    plugins: slash,
    config: (ctx: Ctx) => {
      const spec: PluginSpec<unknown> = {
        props: {
          handleKeyDown: (view, event) => {
            if (!open || open.items.length === 0) return false;
            switch (event.key) {
              case 'ArrowDown':
                selected = (selected + 1) % open.items.length;
                refresh(view);
                return true;
              case 'ArrowUp':
                selected = (selected - 1 + open.items.length) % open.items.length;
                refresh(view);
                return true;
              case 'Enter':
              case 'Tab':
                commit(view, open.items[selected]);
                return true;
              case 'Escape':
                dismissedFrom = open.from;
                open = null;
                refresh(view);
                return true;
              default:
                return false;
            }
          },
        },
        view: () => {
          const menu = new SlashMenu((index) => {
            const view = editorView(getEditor());
            if (!view || !open) return;
            commit(view, open.items[index]);
          });

          const provider = new SlashProvider({
            content: menu.dom,
            // Positioned against `body` in viewport coordinates, so the menu
            // cannot be clipped by the shell's scroller or by
            // `.editor-container`'s `overflow-x: clip`.
            root: document.body,
            floatingUIOptions: { strategy: 'fixed' },
            offset: 6,
            debounce: 0,
            shouldShow: () => open !== null && open.items.length > 0,
          });

          return {
            update: (view) => {
              const run = readOpenRun(view.state);
              if (!run) {
                open = null;
                dismissedFrom = null;
              } else if (dismissedFrom === run.from) {
                // Escape holds for as long as the SAME `/` run is being typed; a
                // new `/` elsewhere still offers the menu.
                open = null;
              } else {
                const sameRun = open?.from === run.from;
                open = run;
                selected = sameRun ? Math.min(selected, run.items.length - 1) : 0;
                dismissedFrom = null;
              }
              if (open && open.items.length > 0) menu.render(open.items, selected);
              provider.update(view);
            },
            destroy: () => {
              provider.destroy();
              menu.destroy();
            },
          };
        },
      };

      ctx.set(slash.key, spec);
    },
  };
}
