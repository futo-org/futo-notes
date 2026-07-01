import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import type { PluginValue, ViewUpdate } from '@codemirror/view';
import { StateEffect, StateField, Prec, EditorSelection, EditorState } from '@codemirror/state';
import type { Transaction } from '@codemirror/state';
import { EDITOR_COMMANDS, filterCommands, type EditorCommand } from './commands';
import { renderIcon } from './icons';

/**
 * Slash command menu.
 *
 * Triggered by typing `/` at a block start (line content before cursor is all whitespace).
 * Also programmatically openable via `openSlashMenuEffect`.
 *
 * State is tracked in a StateField; a ViewPlugin owns the floating DOM and wires the
 * navigation keymap (ArrowUp/Down, Enter, Tab, Escape).
 */

/**
 * Pure positioning helper for the slash menu. Flips above the `/` when the menu
 * would overflow the bottom of the viewport, and clamps horizontally so it never
 * extends past the right edge.
 *
 * Returned coords are in viewport space — callers convert to their host coord
 * frame by subtracting the host's bounding rect.
 */
export function computeMenuPlacement(
  anchor: { top: number; bottom: number; left: number },
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const gap = 4;
  const spaceBelow = viewport.height - anchor.bottom;
  const spaceAbove = anchor.top;

  // Prefer below; flip above if menu won't fit below and there's more room above.
  const flipAbove =
    spaceBelow < menuSize.height + gap &&
    spaceAbove > spaceBelow;
  const top = flipAbove
    ? Math.max(gap, anchor.top - menuSize.height - gap)
    : anchor.bottom + gap;

  // Clamp horizontally — right edge must fit inside viewport with an 8px margin.
  const margin = 8;
  const maxLeft = viewport.width - menuSize.width - margin;
  const left = Math.max(margin, Math.min(anchor.left, maxLeft));

  return { top, left };
}

export interface SlashMenuState {
  open: boolean;
  /** Position of the `/` character in the doc */
  from: number;
}

const STATE_CLOSED: SlashMenuState = { open: false, from: 0 };

export const openSlashMenuEffect = StateEffect.define<{ from: number }>();
export const closeSlashMenuEffect = StateEffect.define<void>();

export const slashMenuField = StateField.define<SlashMenuState>({
  create: () => STATE_CLOSED,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(closeSlashMenuEffect)) return STATE_CLOSED;
      if (e.is(openSlashMenuEffect)) return { open: true, from: e.value.from };
    }
    if (!value.open) return value;

    const from = tr.changes.mapPos(value.from, -1);
    const sel = tr.state.selection.main;

    // Selection must be a single caret after the slash
    if (!sel.empty) return STATE_CLOSED;
    if (sel.from <= from) return STATE_CLOSED;

    // The `/` must still exist at `from`
    if (from >= tr.state.doc.length) return STATE_CLOSED;
    const ch = tr.state.sliceDoc(from, from + 1);
    if (ch !== '/') return STATE_CLOSED;

    // Query must stay on the same line
    const line = tr.state.doc.lineAt(from);
    if (sel.from > line.to) return STATE_CLOSED;

    return { open: true, from };
  },
});

/** Extract the current query string from `from` up to the cursor. */
export function getSlashQuery(state: EditorState): string {
  const v = state.field(slashMenuField, false);
  if (!v || !v.open) return '';
  const sel = state.selection.main;
  return state.sliceDoc(v.from + 1, sel.from);
}

/** True if the cursor is at a position where `/` should open the menu. */
function canOpenAt(state: EditorState, from: number): boolean {
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  return /^\s*$/.test(before);
}

/**
 * Intercept `/` insertion and open the menu when appropriate.
 * Lets the `/` character land in the doc as normal — the menu reads it back as the query prefix.
 */
export const slashInputHandler = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (text !== '/') return false;
    if (from !== to) return false; // replacing a selection — not a trigger case
    if (!canOpenAt(view.state, from)) return false;
    // Already open? Just let the `/` be inserted normally.
    if (view.state.field(slashMenuField, false)?.open) return false;

    view.dispatch({
      changes: { from, to, insert: '/' },
      selection: EditorSelection.cursor(from + 1),
      effects: openSlashMenuEffect.of({ from }),
      userEvent: 'input.type',
    });
    return true;
  }
);

/**
 * Commit the currently-selected command: remove `/query` then run the command.
 */
function commitCommand(view: EditorView, command: EditorCommand): void {
  const field = view.state.field(slashMenuField, false);
  if (!field || !field.open) return;
  const from = field.from;
  const sel = view.state.selection.main;
  const to = sel.from;

  // Delete `/query` first in its own transaction
  view.dispatch({
    changes: { from, to, insert: '' },
    selection: EditorSelection.cursor(from),
    effects: closeSlashMenuEffect.of(),
    userEvent: 'delete',
  });

  // Run command against the new document state (cursor is now at `from`)
  command.run(view, from);
}

/**
 * Floating menu DOM rendered by a ViewPlugin.
 */
class SlashMenuRenderer implements PluginValue {
  private dom: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private selectedIndex = 0;
  /** Commands currently shown, in display order */
  private filtered: EditorCommand[] = EDITOR_COMMANDS;

  constructor(private view: EditorView) {
    this.dom = document.createElement('div');
    this.dom.className = 'sf-slash-menu';
    this.dom.setAttribute('role', 'listbox');
    this.dom.setAttribute('aria-label', 'Insert block');
    this.dom.style.display = 'none';

    this.listEl = document.createElement('div');
    this.listEl.className = 'sf-slash-menu__list';
    this.dom.appendChild(this.listEl);

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'sf-slash-menu__empty';
    this.emptyEl.textContent = 'No matching blocks';
    this.emptyEl.style.display = 'none';
    this.dom.appendChild(this.emptyEl);

    // Mount outside cm-content so our absolute positioning isn't clipped
    view.dom.appendChild(this.dom);

    // Clicks shouldn't steal focus from the editor
    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
  }

  update(update: ViewUpdate): void {
    const field = update.state.field(slashMenuField, false);
    if (!field || !field.open) {
      this.hide();
      return;
    }

    // Recompute filtered commands if doc or selection changed
    const query = getSlashQuery(update.state);
    const next = filterCommands(query);

    // Reset selected index if the filtered list shrank below it, or if the list changed
    const listChanged =
      next.length !== this.filtered.length ||
      next.some((c, i) => c.id !== this.filtered[i]?.id);
    if (listChanged) {
      this.selectedIndex = 0;
    }
    this.filtered = next;

    this.render();
    // Defer layout read until after CM6 finishes its update — reading measured
    // state during `update()` is illegal and throws.
    this.view.requestMeasure({
      read: () => ({
        coords: this.view.coordsAtPos(field.from),
        host: this.view.dom.getBoundingClientRect(),
        menuSize: { width: this.dom.offsetWidth, height: this.dom.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
      write: (r) => {
        if (!r.coords) return;
        const p = computeMenuPlacement(r.coords, r.menuSize, r.viewport);
        this.dom.style.top = `${p.top - r.host.top}px`;
        this.dom.style.left = `${p.left - r.host.left}px`;
      },
    });
  }

  /** Move the selection by `delta`. Wraps. Called from the keymap. */
  move(delta: number): boolean {
    if (!this.filtered.length) return false;
    this.selectedIndex = (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
    this.render();
    return true;
  }

  getSelected(): EditorCommand | null {
    return this.filtered[this.selectedIndex] ?? null;
  }

  private render(): void {
    this.listEl.replaceChildren();
    if (!this.filtered.length) {
      this.listEl.style.display = 'none';
      this.emptyEl.style.display = '';
      this.dom.style.display = '';
      return;
    }
    this.emptyEl.style.display = 'none';
    this.listEl.style.display = '';

    this.filtered.forEach((cmd, i) => {
      const item = document.createElement('div');
      item.className = 'sf-slash-menu__item';
      item.setAttribute('role', 'option');
      item.setAttribute('data-command-id', cmd.id);
      if (i === this.selectedIndex) item.setAttribute('aria-selected', 'true');

      const iconEl = document.createElement('div');
      iconEl.className = 'sf-slash-menu__icon';
      iconEl.innerHTML = renderIcon(cmd.icon);
      item.appendChild(iconEl);

      const textEl = document.createElement('div');
      textEl.className = 'sf-slash-menu__text';

      const labelEl = document.createElement('div');
      labelEl.className = 'sf-slash-menu__label';
      labelEl.textContent = cmd.label;
      textEl.appendChild(labelEl);

      if (cmd.hint) {
        const hintEl = document.createElement('div');
        hintEl.className = 'sf-slash-menu__hint';
        hintEl.textContent = cmd.hint;
        textEl.appendChild(hintEl);
      }
      item.appendChild(textEl);

      item.addEventListener('click', (e) => {
        e.preventDefault();
        commitCommand(this.view, cmd);
      });
      item.addEventListener('mouseenter', () => {
        this.selectedIndex = i;
        // Re-render just the selection state without rebuilding everything
        for (const el of this.listEl.querySelectorAll<HTMLElement>('.sf-slash-menu__item')) {
          if (el === item) el.setAttribute('aria-selected', 'true');
          else el.removeAttribute('aria-selected');
        }
      });

      this.listEl.appendChild(item);
    });

    this.dom.style.display = '';
  }

  private hide(): void {
    this.dom.style.display = 'none';
    this.filtered = EDITOR_COMMANDS;
    this.selectedIndex = 0;
  }

  destroy(): void {
    this.dom.remove();
  }
}

export const slashMenuPlugin = ViewPlugin.fromClass(SlashMenuRenderer);

function isOpen(view: EditorView): boolean {
  return view.state.field(slashMenuField, false)?.open === true;
}

function move(view: EditorView, delta: number): boolean {
  if (!isOpen(view)) return false;
  const plugin = view.plugin(slashMenuPlugin);
  if (!plugin) return false;
  return plugin.move(delta);
}

function commit(view: EditorView): boolean {
  if (!isOpen(view)) return false;
  const plugin = view.plugin(slashMenuPlugin);
  if (!plugin) return false;
  const cmd = plugin.getSelected();
  if (!cmd) return false;
  commitCommand(view, cmd);
  return true;
}

function close(view: EditorView): boolean {
  if (!isOpen(view)) return false;
  view.dispatch({ effects: closeSlashMenuEffect.of() });
  return true;
}

const slashNavigationKeymap = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: (v) => move(v, 1) },
    { key: 'ArrowUp', run: (v) => move(v, -1) },
    { key: 'Enter', run: commit },
    { key: 'Tab', run: commit },
    { key: 'Escape', run: close },
  ])
);

/** Transaction filter: close if the user deletes back past the `/`. */
const slashClosingFilter = EditorState.transactionFilter.of((tr: Transaction) => {
  const field = tr.startState.field(slashMenuField, false);
  if (!field?.open) return tr;
  // If doc still has `/` at `field.from` after the change, leave alone; otherwise close
  if (!tr.docChanged) return tr;
  const newFrom = tr.changes.mapPos(field.from, -1);
  if (newFrom < 0 || newFrom >= tr.newDoc.length) return [tr, { effects: closeSlashMenuEffect.of() }];
  const ch = tr.newDoc.sliceString(newFrom, newFrom + 1);
  if (ch !== '/') return [tr, { effects: closeSlashMenuEffect.of() }];
  return tr;
});

export const slashMenu = [
  slashMenuField,
  slashInputHandler,
  slashMenuPlugin,
  slashNavigationKeymap,
  slashClosingFilter,
];
