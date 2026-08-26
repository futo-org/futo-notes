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

    function focusQuery(): void {
      query.focus();
      query.select();
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

export function findPanel(onQueryFocus?: () => void) {
  const panel = createFindPanel(onQueryFocus);
  return showPanel.from(findState, (value) => (value.open ? panel : null));
}
