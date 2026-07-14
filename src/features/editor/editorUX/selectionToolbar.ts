import { EditorView, showTooltip, tooltips } from '@codemirror/view';
import type { Tooltip } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { toggleBold, toggleItalic, toggleStrikethrough } from '../markdownToolbar';
import { toggleCodeInline, toggleLink } from './linkCommand';
import { renderIcon } from './icons';

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

function shouldShow(state: EditorState): boolean {
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
  dom.setAttribute('aria-label', 'Text formatting');

  function addButton(label: string, iconName: string, onClick: () => void, key?: string): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    btn.title = key ? `${label} (${key})` : label;
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

  addButton('Bold', 'Bold', () => toggleBold(view), 'Mod-B');
  addButton('Italic', 'Italic', () => toggleItalic(view), 'Mod-I');
  addButton('Strikethrough', 'Strikethrough', () => toggleStrikethrough(view), 'Mod-Shift-S');
  addSeparator();
  addButton('Inline code', 'Code', () => toggleCodeInline(view));
  addButton('Link', 'Link', () => toggleLink(view));

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
    if (!tr.docChanged && !tr.selection && !tr.effects.some((e) => e.is(setTableFocusEffect))) {
      return value;
    }
    return buildTooltip(tr.state);
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
