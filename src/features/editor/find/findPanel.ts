import { showPanel, type Panel, type PanelConstructor, type ViewUpdate } from '@codemirror/view';

import { closeFind, findState, requestFindFocusEffect, setFindQuery, stepFind } from './findState';
import { createFindMatchReport } from './findMatches';

function button(label: string, text: string, onclick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'cm-find-button';
  element.setAttribute('aria-label', label);
  element.textContent = text;
  element.onclick = onclick;
  return element;
}

export function createFindPanel(onQueryFocus?: () => void): PanelConstructor {
  return (view): Panel => {
    const dom = document.createElement('div');
    dom.className = 'cm-find-panel';

    const query = document.createElement('input');
    query.className = 'cm-find-query';
    query.dataset.editorBodyFocus = 'false';
    query.type = 'text';
    query.placeholder = 'Find in note';
    query.setAttribute('aria-label', 'Find in note');
    query.setAttribute('autocomplete', 'off');
    query.setAttribute('autocapitalize', 'off');
    query.setAttribute('spellcheck', 'false');
    query.onfocus = () => onQueryFocus?.();
    query.oninput = () => setFindQuery(view, query.value);
    query.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        stepFind(view, event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeFind(view, true);
      }
    };

    const count = document.createElement('span');
    count.className = 'cm-find-count';
    count.setAttribute('aria-live', 'polite');

    dom.append(
      query,
      count,
      button('Previous match', '↑', () => stepFind(view, -1)),
      button('Next match', '↓', () => stepFind(view, 1)),
      button('Close find', '×', () => closeFind(view, true)),
    );

    /**
     * How long after focusing the query a collapsed selection is still read as
     * the engine's doing rather than the user's.
     */
    const SELECTION_REPAIR_MS = 400;

    let cancelSelectionRepair: (() => void) | null = null;

    function selectAll(): void {
      query.setSelectionRange(0, query.value.length);
    }

    /**
     * Hold the seeded query selected across the focus commit.
     *
     * WebKitGTK — the desktop webview — commits a focus move away from the
     * editor body a frame AFTER the `focus()` call, and commits it by dropping
     * the caret at the end of the input, wiping the selection made in the same
     * task. It lands after every animation frame that ran in that frame, so a
     * one-shot re-select loses to it too; Chromium never does it at all, which
     * is why only the real app showed the bug. So watch for the collapse
     * instead of guessing when it arrives, briefly, and stand down the moment
     * the field is the user's (a key, a pointer, or a query they have edited) —
     * their caret always wins.
     */
    function repairSelection(seeded: string): void {
      cancelSelectionRepair?.();
      let timer = 0;
      const stop = (): void => {
        clearTimeout(timer);
        document.removeEventListener('selectionchange', onSelectionChange);
        query.removeEventListener('keydown', stop);
        query.removeEventListener('pointerdown', stop);
        if (cancelSelectionRepair === stop) cancelSelectionRepair = null;
      };
      const onSelectionChange = (): void => {
        if (document.activeElement !== query || query.value !== seeded) stop();
        else if (query.selectionStart !== 0 || query.selectionEnd !== seeded.length) selectAll();
      };
      timer = window.setTimeout(stop, SELECTION_REPAIR_MS);
      cancelSelectionRepair = stop;
      document.addEventListener('selectionchange', onSelectionChange);
      query.addEventListener('keydown', stop);
      query.addEventListener('pointerdown', stop);
    }

    function focusQuery(): void {
      query.focus();
      selectAll();
      repairSelection(query.value);
    }

    function render(): void {
      const value = view.state.field(findState);
      if (query.value !== value.query) query.value = value.query;
      count.textContent = createFindMatchReport(
        value.query,
        value.currentIndex,
        value.matches.length,
      ).label;
    }

    render();
    return {
      dom,
      top: false,
      mount: focusQuery,
      destroy() {
        cancelSelectionRepair?.();
      },
      update(update: ViewUpdate) {
        render();
        if (
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(requestFindFocusEffect)),
          )
        ) {
          focusQuery();
        }
      },
    };
  };
}

export function findPanel(panel: PanelConstructor) {
  return showPanel.from(findState, (value) => (value.open ? panel : null));
}
