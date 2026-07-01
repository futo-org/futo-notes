import { EditorView, showTooltip, tooltips } from '@codemirror/view';
import type { Tooltip } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { toggleBold, toggleItalic, toggleStrikethrough } from '$lib/markdownToolbar';
import { toggleCodeInline, toggleLink } from './linkCommand';
import { renderIcon } from './icons';

/**
 * Desktop floating formatting toolbar shown above a non-empty text selection.
 *
 * Disclosure rules (matches Milkdown Crepe's Toolbar feature):
 * - selection is non-empty
 * - selection does not cross a line break (long drag-selects don't pop a toolbar mid-gesture)
 * - selection is not entirely inside a block we want to stay out of (code blocks, tables)
 *
 * Buttons reuse existing markdown toggle commands (`markdownToolbar.ts`) plus
 * `linkCommand.ts` for code/link. `mousedown: preventDefault` keeps the CM6
 * selection alive so the command sees the original range.
 */

export const setTableFocusEffect = StateEffect.define<boolean>();

/** Signals from the table editor that a cell is focused — hide the toolbar in that case. */
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

/** True when `pos` sits inside inline code or a fenced/indented code block. */
export function isInsideCode(state: EditorState, pos: number): boolean {
  // Walk ancestors via a TreeCursor to avoid a nullable SyntaxNode reassign.
  const cur = syntaxTree(state).cursorAt(pos, -1);
  do {
    // markdown node names: InlineCode, FencedCode, CodeBlock, CodeText, CodeMark
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
  // Stay out of code (inline or fenced): the spec hides the toolbar inside
  // tables/code. Multi-line code is already excluded by the line check above;
  // this covers a single-line selection inside inline code or a fenced block.
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
    // Prevent the editor from losing its selection to the button
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
    // strictSide:false plus a tooltipSpace() that excludes the tag bar lets
    // CM6 itself flip to below when "above" would clip into the title/tag
    // area on the first body line.
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

// Render desktop tooltips in a body-level container using fixed positioning so
// they escape the editor's overflow-hidden scroll ancestors (.editor-container,
// .note-body). Without this, a selection in the first visible line clips the
// floating toolbar behind the note title / tag bar above the editor.
//
// `tooltipSpace` shrinks the available area by the bottom of the .note-tag-bar
// (when present) so CM6 will auto-flip the toolbar below the line on the
// first body row instead of laying it on top of the +Tag pill.
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
