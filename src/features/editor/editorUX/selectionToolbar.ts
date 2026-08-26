import { EditorView, showTooltip, tooltips } from '@codemirror/view';
import type { Tooltip } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { findState, openFindEffect } from '../find/findState';
import { toggleBold, toggleItalic, toggleStrikethrough } from '../markdownToolbar';
import { toggleCodeInline, toggleLink } from './linkCommand';
import { renderIcon } from './icons';
import { localizedText } from '$shared/localization';

export const setTableFocusEffect = StateEffect.define<boolean>();

export const tableFocusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setTableFocusEffect)) return e.value;
    }
    return value;
  },
});

function getTableFocused(state: EditorState): boolean {
  return state.field(tableFocusField, false) === true;
}

export function isInsideCode(state: EditorState, pos: number): boolean {
  const cur = syntaxTree(state).cursorAt(pos, -1);
  do {
    if (/Code/.test(cur.name)) return true;
  } while (cur.parent());
  return false;
}

/**
 * Find moves a REAL selection onto each match it steps to, which would pop the
 * formatting bubble over the text on every step and leave it following the
 * stepping. The bubble is for a selection the user made, so it stays down for
 * the whole find session. → docs/spec/editor.md (Find in note)
 */
function isFindActive(state: EditorState): boolean {
  return state.field(findState, false)?.open === true;
}

function shouldShow(state: EditorState): boolean {
  if (isFindActive(state)) return false;

  const sel = state.selection.main;
  if (sel.empty) return false;

  const from = state.doc.lineAt(sel.from);
  const to = state.doc.lineAt(sel.to);
  if (from.number !== to.number) return false;

  if (getTableFocused(state)) return false;
  if (isInsideCode(state, sel.from) || isInsideCode(state, sel.to)) return false;
  return true;
}

function createToolbarDom(view: EditorView): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'sf-selection-toolbar';
  dom.setAttribute('role', 'toolbar');
  dom.setAttribute('aria-label', localizedText('editor.selectionToolbar.accessibilityLabel'));

  function addButton(label: string, title: string, iconName: string, onClick: () => void): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    btn.title = title;
    btn.innerHTML = renderIcon(iconName);
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    dom.appendChild(btn);
  }

  function addSeparator(): void {
    const sep = document.createElement('div');
    sep.className = 'sf-toolbar-separator';
    dom.appendChild(sep);
  }

  addButton(
    localizedText('editor.selectionToolbar.bold'),
    localizedText('editor.selectionToolbar.boldTitle'),
    'Bold',
    () => toggleBold(view),
  );
  addButton(
    localizedText('editor.selectionToolbar.italic'),
    localizedText('editor.selectionToolbar.italicTitle'),
    'Italic',
    () => toggleItalic(view),
  );
  addButton(
    localizedText('editor.selectionToolbar.strikethrough'),
    localizedText('editor.selectionToolbar.strikethroughTitle'),
    'Strikethrough',
    () => toggleStrikethrough(view),
  );
  addSeparator();
  addButton(
    localizedText('editor.selectionToolbar.inlineCode'),
    localizedText('editor.selectionToolbar.inlineCode'),
    'Code',
    () => toggleCodeInline(view),
  );
  addButton(
    localizedText('editor.selectionToolbar.link'),
    localizedText('editor.selectionToolbar.link'),
    'Link',
    () => toggleLink(view),
  );

  return dom;
}

function buildTooltip(state: EditorState): Tooltip | null {
  if (!shouldShow(state)) return null;
  const sel = state.selection.main;
  return {
    pos: sel.from,
    end: sel.to,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view) => ({ dom: createToolbarDom(view) }),
  };
}

const selectionToolbarField = StateField.define<Tooltip | null>({
  create(state) {
    return buildTooltip(state);
  },
  update(value, tr) {
    // Opening find has to hide the bubble even when it moves no selection.
    // CLOSING it deliberately does not rebuild: Escape leaves the selection on
    // the match (editor.md), and rebuilding there would pop the bubble for a
    // selection find placed, not one the user made. The next selection the user
    // makes rebuilds normally.
    // `tr.reconfigured` catches an interface-language change: the bubble's
    // labels come from the catalog, so a reconfigure has to rebuild them.
    const rebuild =
      tr.docChanged ||
      tr.selection ||
      tr.reconfigured ||
      tr.effects.some((e) => e.is(setTableFocusEffect) || e.is(openFindEffect));
    return rebuild ? buildTooltip(tr.state) : value;
  },
  provide: (f) => showTooltip.from(f),
});

export const selectionToolbar = [
  tableFocusField,
  selectionToolbarField,
  tooltips({
    parent: document.body,
    position: 'fixed',
    tooltipSpace: () => {
      const top = document.querySelector('.note-tag-bar')?.getBoundingClientRect().bottom ?? 0;
      return {
        left: 0,
        top,
        right: window.innerWidth,
        bottom: window.innerHeight,
      };
    },
  }),
];
